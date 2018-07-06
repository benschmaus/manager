import * as React from 'react';
import * as Joi from 'joi';
import * as Promise from 'bluebird';
import {
  withStyles,
  StyleRulesCallback,
  Theme,
  WithStyles,
} from '@material-ui/core/styles';
import {
  compose,
  append,
  defaultTo,
  clone,
  path,
  lensPath,
  pathOr,
  set,
  view,
  over,
  Lens,
} from 'ramda';
import { withRouter, RouteComponentProps } from 'react-router-dom';

import Typography from '@material-ui/core/Typography';

import { getLinodes } from 'src/services/linodes';
import {
  getNodeBalancerConfigs,
  updateNodeBalancerConfig,
  createNodeBalancerConfig,
  deleteNodeBalancerConfig,
  createNodeBalancerConfigSchema,
  getNodeBalancerConfigNodes,
  createNodeBalancerConfigNode,
  updateNodeBalancerConfigNode,
  deleteNodeBalancerConfigNode,
} from 'src/services/nodebalancers';
import Button from 'src/components/Button';
import Grid from 'src/components/Grid';
import ExpansionPanel from 'src/components/ExpansionPanel';
import PromiseLoader, { PromiseLoaderResponse } from 'src/components/PromiseLoader/PromiseLoader';
import ConfirmationDialog from 'src/components/ConfirmationDialog';
import ActionsPanel from 'src/components/ActionsPanel';

import { lensFrom, validationErrorsToFieldErrors } from '../NodeBalancerCreate';
import NodeBalancerConfigPanel from '../NodeBalancerConfigPanel';
import {
  nodeForRequest,
  transformConfigsForRequest,
  NodeBalancerConfigFields,
  formatAddress,
  parseAddresses,
  parseAddress,
  clampNumericString,
  createNewNodeBalancerConfig,
  createNewNodeBalancerConfigNode,
} from '../utils';
import scrollErrorIntoView from 'src/utilities/scrollErrorIntoView';

type ClassNames = 'root' | 'title';

const styles: StyleRulesCallback<ClassNames> = (theme: Theme) => ({
  root: {},
  title: {
    marginTop: theme.spacing.unit,
    marginBottom: theme.spacing.unit * 2,
  },
});

interface Props { }

type MatchProps = { nodeBalancerId?: number };
type RouteProps = RouteComponentProps<MatchProps>;

interface PreloadedProps {
  configs: PromiseLoaderResponse<Linode.ResourcePage<NodeBalancerConfigFields>>;
}

interface State {
  linodesWithPrivateIPs: Linode.Linode[],
  configs: NodeBalancerConfigFields[];
  configErrors: Linode.ApiFieldError[][];
  configSubmitting: boolean[];
  panelMessages: string[];
  panelNodeMessages: string[];
  /*
   * If the following is set to true, then the last element of each of the above
   * arrays is related to this unsaved config.
   */
  hasUnsavedConfig: boolean;
  deleteConfigConfirmDialog: {
    open: boolean;
    submitting: boolean;
    errors?: Linode.ApiFieldError[];
    idxToDelete?: number;
  };
}

type CombinedProps =
  Props
  & RouteProps
  & WithStyles<ClassNames>
  & PreloadedProps;

const getConfigsWithNodes = (nodeBalancerId: number) => {
  return getNodeBalancerConfigs(nodeBalancerId).then((configs) => {
    return Promise.map(configs.data, (config) => {
      return getNodeBalancerConfigNodes(nodeBalancerId, config.id)
        .then(({ data: nodes }) => {
          return {
            ...config,
            nodes: parseAddresses(nodes),
          };
        });
    })
      .catch(e => []);
  });
};

class NodeBalancerConfigurations extends React.Component<CombinedProps, State> {
  static defaultDeleteConfigConfirmDialogState = {
    submitting: false,
    open: false,
    errors: undefined,
    idxToDelete: undefined,
  };

  static defaultDeleteNodeConfirmDialogState = {
    submitting: false,
    open: false,
    errors: undefined,
    configIdxToDelete: undefined,
    nodeIdxToDelete: undefined,
  };

  state: State = {
    linodesWithPrivateIPs: [],
    configs: pathOr([], ['response'], this.props.configs),
    configErrors: [],
    configSubmitting: [],
    panelMessages: [],
    panelNodeMessages: [],
    deleteConfigConfirmDialog:
      clone(NodeBalancerConfigurations.defaultDeleteConfigConfirmDialogState),
    hasUnsavedConfig: false,
  };

  resetSubmitting = (configIdx: number) => {
    // reset submitting
    const newSubmitting = clone(this.state.configSubmitting);
    newSubmitting[configIdx] = false;
    this.setState({
      configSubmitting: newSubmitting,
    });
  }

  clearNodeErrors = (configIdx: number) => {
    // Build paths to all node errors
    const paths = this.state.configs[configIdx].nodes.map((nodes, idxN) => {
      return ['nodes', idxN, 'errors'];
    });
    if (paths.length === 0) { return; }
    /* Map those paths to an array of updater functions */
    const setFns = paths.map((path: any[]) => {
      return set(lensPath(['configs', configIdx, ...path]), []);
    });
    /* Apply all of those update functions at once to state */
    this.setState(
      (compose as any)(...setFns),
    );
  }

  fieldErrorsToNodePathErrors = (errors: Linode.ApiFieldError[]) => {
    /* Return objects with this shape
        {
          path: [0, 'errors'],
          error: {
            field: 'label',
            reason: 'label cannot be blank"
          }
        }
    */
    const nodePathErrors = errors.reduce(
      (acc: any, error: Linode.ApiFieldError) => {
        const match = /^nodes_(\d+)_(\w+)$/.exec(error.field!);
        if (match && match[1] && match[2]) {
          return [
            ...acc,
            {
              path: [+match[1], 'errors'],
              error: {
                field: match[2],
                reason: error.reason,
              },
            },
          ];
        }
        return acc;
      },
      [],
    );
    return nodePathErrors;
  }

  setNodeErrors = (configIdx: number, error: Linode.ApiFieldError[]) => {
    /* Map the objects with this shape
        {
          path: [0, 'errors'],
          error: {
            field: 'label',
            reason: 'label cannot be blank"
          }
        }
      to an array of functions that will append the error at the
      given path in the config state
    */
    const nodePathErrors = this.fieldErrorsToNodePathErrors(error);

    if (nodePathErrors.length === 0) { return; }

    const setFns = nodePathErrors.map((nodePathError: any) => {
      return compose(
        over(lensPath(['configs', configIdx, 'nodes', ...nodePathError.path]),
              append(nodePathError.error)),
        defaultTo([]),
      );
    });

    // Apply the error updater functions with a compose
    this.setState(
      (compose as any)(...setFns),
      () => {
        scrollErrorIntoView(`${configIdx}`);
      },
    );
  }

  saveConfigUpdatePath = (
    idx: number,
    config: NodeBalancerConfigFields,
    configPayload: Partial<Linode.NodeBalancerConfig>,
  ) => {
    /* Update a config and its nodes simultaneously */
    const { match: { params: { nodeBalancerId } } } = this.props;
    const nodeBalUpdate = updateNodeBalancerConfig(nodeBalancerId!, config.id!, configPayload)
      .then((nodeBalancerConfig) => {
        // update config data
        const newConfigs = clone(this.state.configs);
        newConfigs[idx] = nodeBalancerConfig as NodeBalancerConfigFields;
        const newNodes = clone(this.state.configs[idx].nodes);
        //    while maintaing node data
        newConfigs[idx].nodes = newNodes;

        // reset errors
        const newErrors = clone(this.state.configErrors);
        newErrors[idx] = [];

        // reset submitting
        const newSubmitting = clone(this.state.configSubmitting);
        newSubmitting[idx] = false;

        this.setState({
          configs: newConfigs,
          configErrors: newErrors,
          configSubmitting: newSubmitting,
        });
        /* Return true as a Promise for the sake of aggregating results */
        return true;
      })
      .catch((errorResponse) => {
        // update errors
        const errors = path<Linode.ApiFieldError[]>(['response', 'data', 'errors'], errorResponse);
        const newErrors = clone(this.state.configErrors);
        newErrors[idx] = errors || [];
        this.setState({
          configErrors: newErrors,
        }, () => {
          scrollErrorIntoView(`${idx}`);
        });
        this.resetSubmitting(idx);
        /* Return false as a Promise for the sake of aggregating results */
        return false;
      });

    // These Node operations execute while the config update request is being made
    const nodeUpdates = config.nodes.map((node, nodeIdx) => {
      if (node.modifyStatus === 'delete') {
        return this.deleteNode(idx, nodeIdx);
      }
      if (node.modifyStatus === 'new') {
        return this.createNode(idx, nodeIdx);
      }
      if (node.modifyStatus === 'update') {
        return this.updateNode(idx, nodeIdx);
      }
      return new Promise(resolve => resolve(undefined));
    });

    /* Set the success message if all of the requests succeed */
    Promise.all([nodeBalUpdate, ...nodeUpdates] as any)
      .then((responseVals) => {
        const [nodeBalSuccess, ...nodeResults] = responseVals;
        if (nodeBalSuccess) {
          // replace Config success message with a new one
          const newMessages = [];
          newMessages[idx] = 'NodeBalancer Configuration updated successfully';
          this.setState({
            panelMessages: newMessages,
          });
        }
        const filteredNodeResults = nodeResults.filter(el => el !== undefined);
        if (filteredNodeResults.length) {
          const nodeSuccess = filteredNodeResults.reduce((acc: boolean, val: boolean) => {
            return acc && val;
          }, true);
          if (nodeSuccess) {
            // replace Node success message with a new one
            const newMessages = [];
            newMessages[idx] = 'All Nodes updated successfully';
            this.setState({
              panelNodeMessages: newMessages,
            });
          }
        }
        this.resetSubmitting(idx);
      })
      .catch((requestFailure) => {
        this.resetSubmitting(idx);
      });
  }

  saveConfigNewPath = (
    idx: number,
    config: NodeBalancerConfigFields,
    configPayload: Partial<Linode.NodeBalancerConfig>,
  ) => {
    /*
     * Create a config and then its nodes.
     * If the config creation succeeds here, the UpdatePath will be used upon
     * subsequent saves.
    */
    const { match: { params: { nodeBalancerId } } } = this.props;
    createNodeBalancerConfig(nodeBalancerId!, configPayload)
      .then((nodeBalancerConfig) => {
        // update config data
        const newConfigs = clone(this.state.configs);
        newConfigs[idx] = nodeBalancerConfig as NodeBalancerConfigFields;
        const newNodes = clone(this.state.configs[idx].nodes);
        //    while maintaing node data
        newConfigs[idx].nodes = newNodes;

        // reset errors
        const newErrors = clone(this.state.configErrors);
        newErrors[idx] = [];

        this.setState({
          configs: newConfigs,
          configErrors: newErrors,
        }, () => {
          // replace success message with a new one
          const newMessages = [];
          newMessages[idx] = 'New NodeBalancer Configuration created successfully';
          this.setState({
            panelMessages: newMessages,
          });

          // Allow the user to add yet another config
          this.setState({
            hasUnsavedConfig: false,
          });

          // Execute Node operations now that the config has been created
          const nodeUpdates = config.nodes.map((node, nodeIdx) => {
            if (node.modifyStatus !== 'delete') {
              /* All of the Nodes are new since the config was just created */
              return this.createNode(idx, nodeIdx);
            }
            return new Promise(resolve => resolve(true));
          });

          /* Set the success message if all of the requests succeed */
          Promise.all([...nodeUpdates] as any)
            .then((responseVals) => {
              const success = responseVals.reduce((acc: boolean, val: boolean) => {
                return acc && val;
              }, true);
              if (success) {
                // replace success message with a new one
                const newMessages = [];
                newMessages[idx] = 'All Nodes created successfully';
                this.setState({
                  panelNodeMessages: newMessages,
                });
              }
              this.resetSubmitting(idx);
            })
            .catch((requestFailure) => {
              this.resetSubmitting(idx);
            });
        });
      })
      .catch((errorResponse) => {
        // update errors
        const errors = path<Linode.ApiFieldError[]>(['response', 'data', 'errors'], errorResponse);
        const newErrors = clone(this.state.configErrors);
        newErrors[idx] = errors || [];
        this.setState({
          configErrors: newErrors,
        }, () => {
          scrollErrorIntoView(`${idx}`);
        });
        // reset submitting
        this.resetSubmitting(idx);
      });
  }

  clearMessages = () => {
    // clear any success messages
    this.setState({
      panelMessages: [],
      panelNodeMessages: [],
    });
  }

  saveConfig = (idx: number) => {
    const config = this.state.configs[idx];

    const configPayload: Partial<Linode.NodeBalancerConfig> =
      transformConfigsForRequest([config])[0];

    // clear node errors for this config if there are any
    this.clearNodeErrors(idx);

    this.clearMessages();

    // first, validate client-side
    const { error: validationErrors } = Joi.validate(
      configPayload,
      createNodeBalancerConfigSchema,
      { abortEarly: false },
    );

    if (validationErrors) {
      const newErrors = clone(this.state.configErrors);
      newErrors[idx] = validationErrorsToFieldErrors(validationErrors);
      this.setState({ configErrors: newErrors }, () => {
        scrollErrorIntoView(`${idx}`);
      });
      this.setNodeErrors(idx, newErrors[idx]);
      return;
    }

    const newSubmitting = clone(this.state.configSubmitting);
    newSubmitting[idx] = true;
    this.setState({
      configSubmitting: newSubmitting,
    });

    if (config.modifyStatus !== 'new') {
      // If updating Config, perform the update and Node operations simultaneously.
      this.saveConfigUpdatePath(idx, config, configPayload);
    } else {
      // If it's a new Config, perform the update and Node operations sequentially.
      this.saveConfigNewPath(idx, config, configPayload);
    }
  }

  deleteConfig = (e: any) => {
    const { deleteConfigConfirmDialog: { idxToDelete } } = this.state;
    if (idxToDelete === undefined) { return; }

    // remove an unsaved config from state
    const config = this.state.configs[idxToDelete];
    if (config.modifyStatus === 'new') {
      const newConfigs = clone(this.state.configs);
      newConfigs.splice(idxToDelete, 1);
      this.setState({
        configs: newConfigs,
        deleteConfigConfirmDialog:
          clone(NodeBalancerConfigurations.defaultDeleteConfigConfirmDialogState),
        /* Important to reset this so that we can add another config */
        hasUnsavedConfig: false,
      });
      return;
    }

    this.setState({
      deleteConfigConfirmDialog: {
        ...this.state.deleteConfigConfirmDialog,
        errors: undefined,
        submitting: true,
      },
    });

    const { match: { params: { nodeBalancerId } } } = this.props;

    // actually delete a real config
    deleteNodeBalancerConfig(nodeBalancerId!, (config!.id!))
      .then((response) => {
        // update config data
        const newConfigs = clone(this.state.configs);
        newConfigs.splice(idxToDelete, 1);
        this.setState({
          configs: newConfigs,
          deleteConfigConfirmDialog:
            clone(NodeBalancerConfigurations.defaultDeleteConfigConfirmDialogState),
        });
      })
      .catch((err) => {
        const apiError = path<Linode.ApiFieldError[]>(['response', 'data', 'error'], err);

        return this.setState({
          deleteConfigConfirmDialog: {
            ...this.state.deleteConfigConfirmDialog,
            submitting: false,
            errors: apiError
              ? apiError
              : [{ field: 'none', reason: 'Unable to complete your request at this time.' }],
          },
        }, () => {
          scrollErrorIntoView(`${idxToDelete}`);
        });
      });
  }

  updateNodeErrors = (configIdx: number, nodeIdx: number, errors: Linode.ApiFieldError[]) => {
    this.setState(
      set(
        lensPath(['configs', configIdx, 'nodes', nodeIdx, 'errors']),
        errors,
      ),
      () => {
        scrollErrorIntoView(`${configIdx}`);
      },
    );
  }

  removeNode = (configIdx: number) => (nodeIdx: number) => {
    this.clearMessages();
    if (this.state.configs[configIdx].nodes[nodeIdx].id !== undefined) {
      /* If the node has an ID, mark it for deletion when the user saves the config */
      this.setState(
        set(
          lensPath(['configs', configIdx, 'nodes', nodeIdx, 'modifyStatus']),
          'delete',
        ),
      );
    } else {
      /* If the node doesn't have an ID, remove it from state immediately */
      this.setState(
        over(
          lensPath(['configs', configIdx, 'nodes']),
          nodes => nodes.filter((n: any, idx: number) => idx !== nodeIdx),
        ),
      );
    }
  }

  deleteNode = (configIdx: number, nodeIdx: number) => {
    const { match: { params: { nodeBalancerId } } } = this.props;
    const config = this.state.configs[configIdx];
    const node = this.state.configs[configIdx].nodes[nodeIdx];

    return deleteNodeBalancerConfigNode(nodeBalancerId!, config.id!, node.id!)
      .then(() => {
        this.setState(
          over(
            lensPath(['configs', configIdx!, 'nodes']),
            nodes => nodes.filter((n: any, idx: number) => idx !== nodeIdx!),
          ),
        );
        /* Return true as a Promise for the sake of aggregating results */
        return true;
      })
      .catch((err) => {
        /* Return false as a Promise for the sake of aggregating results */
        return false;
        /* @todo:
        const apiError = path<Linode.ApiFieldError[]>(['response', 'data', 'error'], err);

            place an error on the node and set toDelete to undefined

        */
      });
  }

  addNode = (configIdx: number) => () => {
    this.setState(
      set(
        lensPath(['configs', configIdx, 'nodes']),
        append(createNewNodeBalancerConfigNode())(this.state.configs[configIdx].nodes),
      ),
    );
  }

  createNode = (configIdx: number, nodeIdx: number) => {
    const { match: { params: { nodeBalancerId } } } = this.props;
    const config = this.state.configs[configIdx];
    const node = this.state.configs[configIdx].nodes[nodeIdx];

    const nodeData = nodeForRequest(node);

    return createNodeBalancerConfigNode(nodeBalancerId!, config.id!, formatAddress(nodeData))
      .then((node) => {
        /* Set the new Node data including the ID
           This also clears the errors and modify status. */
        this.setState(
          set(
            lensPath(['configs', configIdx, 'nodes', nodeIdx]),
            parseAddress(node),
          ),
        );
        /* Return true as a Promise for the sake of aggregating results */
        return true;
      })
      .catch((errResponse) => {
        /* Set errors for this node */
        const errors = pathOr([], ['response', 'data', 'errors'], errResponse);
        this.updateNodeErrors(configIdx, nodeIdx, errors);
        /* Return false as a Promise for the sake of aggregating results */
        return false;
      });
  }

  setNodeValue = (cidx: number, nodeidx: number, key: string, value: any) => {
    this.clearMessages();
    /* Check if the node is new */
    const { modifyStatus } = this.state.configs[cidx].nodes[nodeidx];
    /* If it's not new or for deletion set it to be updated */
    if (!(modifyStatus === 'new' || modifyStatus === 'delete')) {
      this.setState(
        set(
          lensPath(['configs', cidx, 'nodes', nodeidx, 'modifyStatus']),
          'update',
        ));
    }
    /* Set the { key: value } pair requested */
    this.setState(
      set(
        lensPath(['configs', cidx, 'nodes', nodeidx, key]),
        value,
      ));
  }

  updateNode = (configIdx: number, nodeIdx: number) => {
    const { match: { params: { nodeBalancerId } } } = this.props;
    const config = this.state.configs[configIdx];
    const node = this.state.configs[configIdx].nodes[nodeIdx];

    const nodeData = nodeForRequest(node);

    return (
      updateNodeBalancerConfigNode(nodeBalancerId!, config.id!, node!.id!, formatAddress(nodeData))
      .then((node) => {
        /* Set the new Node data including the ID
           This also clears the errors and modify status. */
        this.setState(
          set(
            lensPath(['configs', configIdx, 'nodes', nodeIdx]),
            parseAddress(node),
          ),
        );
        /* Return true as a Promise for the sake of aggregating results */
        return true;
      })
      .catch((errResponse) => {
        /* Set errors for this node */
        const errors = pathOr([], ['response', 'data', 'errors'], errResponse);
        this.updateNodeErrors(configIdx, nodeIdx, errors);
        /* Return false as a Promise for the sake of aggregating results */
        return false;
      })
    );
  }

  addNodeBalancerConfig = () => {
    this.setState({
      configs: append(createNewNodeBalancerConfig(false), this.state.configs),
      configErrors: append([], this.state.configErrors),
      configSubmitting: append(false, this.state.configSubmitting),
      hasUnsavedConfig: true,
    });
  }

  onNodeLabelChange = (configIdx: number) => (nodeIdx: number, value: string) =>
    this.setNodeValue(configIdx, nodeIdx, 'label', value)

  onNodeAddressChange = (configIdx: number) => (nodeIdx: number, value: string) =>
    this.setNodeValue(configIdx, nodeIdx, 'address', value)

  onNodePortChange = (configIdx: number) => (nodeIdx: number, value: string) =>
    this.setNodeValue(configIdx, nodeIdx, 'port', value)

  onNodeWeightChange = (configIdx: number) => (nodeIdx: number, value: string) =>
    this.setNodeValue(configIdx, nodeIdx, 'weight', value)

  onNodeModeChange = (configIdx: number) => (nodeIdx: number, value: string) => {
    this.setNodeValue(configIdx, nodeIdx, 'mode', value);
  }

  onCloseConfirmation = () => this.setState({
    deleteConfigConfirmDialog:
      clone(NodeBalancerConfigurations.defaultDeleteConfigConfirmDialogState),
  })

  confirmationConfigError = () =>
    (this.state.deleteConfigConfirmDialog.errors || []).map(e => e.reason).join(',')

  updateState = (lens: Lens) => (value: any) => {
    this.clearMessages();
    this.setState(set(lens, value));
  }

  updateStateWithClamp = (lens: Lens) => (value: any) => {
    const clampedValue = clampNumericString(0, Number.MAX_SAFE_INTEGER)(value);
    this.setState(set(lens, clampedValue));
  }

  onSaveConfig = (idx: number) => () => this.saveConfig(idx);

  onDeleteConfig = (idx: number) => () => {
    this.setState({
      deleteConfigConfirmDialog: {
        ...clone(NodeBalancerConfigurations.defaultDeleteConfigConfirmDialogState),
        open: true,
        idxToDelete: idx,
      },
    });
  }

  renderConfig = (
    panelMessages: string[],
    configErrors: any[],
    configSubmitting: any[],
  ) => (
    config: Linode.NodeBalancerConfig & { nodes: Linode.NodeBalancerConfigNode[] }, idx: number,
    ) => {
    const isNewConfig = this.state.hasUnsavedConfig && idx === this.state.configs.length - 1;
    const { panelNodeMessages } = this.state;

    const lensTo = lensFrom(['configs', idx]);

    const algorithmLens = lensTo(['algorithm']);
    const checkPassiveLens = lensTo(['check_passive']);
    const checkBodyLens = lensTo(['check_body']);
    const checkPathLens = lensTo(['check_path']);
    const portLens = lensTo(['port']);
    const protocolLens = lensTo(['protocol']);
    const healthCheckTypeLens = lensTo(['check']);
    const healthCheckAttemptsLens = lensTo(['check_attempts']);
    const healthCheckIntervalLens = lensTo(['check_interval']);
    const healthCheckTimeoutLens = lensTo(['check_timeout']);
    const sessionStickinessLens = lensTo(['stickiness']);
    const sslCertificateLens = lensTo(['ssl_cert']);
    const privateKeyLens = lensTo(['ssl_key']);

    return (
      <ExpansionPanel
        key={idx}
        updateFor={[
          idx,
          config,
          configSubmitting[idx],
          configErrors[idx],
          panelMessages[idx],
          panelNodeMessages[idx],
        ]}
        defaultExpanded={isNewConfig}
        success={panelMessages[idx]}
        heading={`Port ${config.port !== undefined ? config.port : ''}`}
      >
        <NodeBalancerConfigPanel
          linodesWithPrivateIPs={this.state.linodesWithPrivateIPs}
          forEdit
          configIdx={idx}
          onSave={this.onSaveConfig(idx)}
          submitting={configSubmitting[idx]}
          onDelete={this.onDeleteConfig(idx)}

          errors={configErrors[idx]}
          nodeMessage={panelNodeMessages[idx]}

          algorithm={view(algorithmLens, this.state)}
          onAlgorithmChange={this.updateState(algorithmLens)}

          checkPassive={view(checkPassiveLens, this.state)}
          onCheckPassiveChange={this.updateState(checkPassiveLens)}

          checkBody={view(checkBodyLens, this.state)}
          onCheckBodyChange={this.updateState(checkBodyLens)}

          checkPath={view(checkPathLens, this.state)}
          onCheckPathChange={this.updateState(checkPathLens)}

          port={view(portLens, this.state)}
          onPortChange={this.updateState(portLens)}

          protocol={view(protocolLens, this.state)}
          onProtocolChange={(value: any) => {
            this.updateState(protocolLens)(value);
            /* clear cert and private key upon changing protocol so that they are re-validated */
            this.setState(
              compose(
                set(sslCertificateLens, ''),
                set(privateKeyLens, ''),
              ),
            );
          }}

          healthCheckType={view(healthCheckTypeLens, this.state)}
          onHealthCheckTypeChange={this.updateState(healthCheckTypeLens)}

          healthCheckAttempts={view(healthCheckAttemptsLens, this.state)}
          onHealthCheckAttemptsChange={this.updateStateWithClamp(healthCheckAttemptsLens)}

          healthCheckInterval={view(healthCheckIntervalLens, this.state)}
          onHealthCheckIntervalChange={this.updateStateWithClamp(healthCheckIntervalLens)}

          healthCheckTimeout={view(healthCheckTimeoutLens, this.state)}
          onHealthCheckTimeoutChange={this.updateStateWithClamp(healthCheckTimeoutLens)}

          sessionStickiness={view(sessionStickinessLens, this.state)}
          onSessionStickinessChange={this.updateState(sessionStickinessLens)}

          sslCertificate={view(sslCertificateLens, this.state)}
          onSslCertificateChange={this.updateState(sslCertificateLens)}

          privateKey={view(privateKeyLens, this.state)}
          onPrivateKeyChange={this.updateState(privateKeyLens)}

          nodes={config.nodes}

          addNode={this.addNode(idx)}

          removeNode={this.removeNode(idx)}

          onNodeLabelChange={this.onNodeLabelChange(idx)}

          onNodeAddressChange={this.onNodeAddressChange(idx)}

          onNodePortChange={this.onNodePortChange(idx)}

          onNodeWeightChange={this.onNodeWeightChange(idx)}

          onNodeModeChange={this.onNodeModeChange(idx)}
        />
      </ExpansionPanel>
    );
  }

  renderConfigConfirmationActions = ({ onClose }: { onClose: () => void }) => (
    <ActionsPanel style={{ padding: 0 }}>
      <Button
        data-qa-confirm-cancel
        onClick={this.deleteConfig}
        type="secondary"
        destructive
        loading={this.state.deleteConfigConfirmDialog.submitting}
      >
        Delete
    </Button>
      <Button
        onClick={() => onClose()}
        type="secondary"
        className="cancel"
        data-qa-cancel-cancel
      >
        Cancel
    </Button>
    </ActionsPanel>
  )

  componentDidMount() {
    getLinodes()
      .then(result => {
        const privateIPRegex = /^10\.|^172\.1[6-9]\.|^172\.2[0-9]\.|^172\.3[0-1]\.|^192\.168\.|^fd/;
        const linodesWithPrivateIPs = result.data.filter((linode) => {
          return linode.ipv4.some(ipv4 => !!ipv4.match(privateIPRegex)); // does it have a private IP address
        });
        this.setState({ linodesWithPrivateIPs });
      })
      // we don't really need to do anything here because if the request fails
      // the user won't be presented with any suggestions when typing in the
      // node address field, which isn't the end of the world.
      .catch(err => err);
  }

  render() {
    const { classes } = this.props;
    const {
      configs,
      configErrors,
      configSubmitting,
      panelMessages,
      hasUnsavedConfig,
    } = this.state;

    return (
      <React.Fragment>
        <Typography
          variant="headline"
          data-qa-title
          className={classes.title}
        >
          NodeBalancer Configurations
        </Typography>

        {configs.map(this.renderConfig(panelMessages, configErrors, configSubmitting))}

        {!hasUnsavedConfig &&
          <Grid item style={{ marginTop: 16 }}>
            <Button
              type="secondary"
              onClick={() => this.addNodeBalancerConfig()}
              data-qa-add-config
            >
              {configs.length === 0 ? 'Add a Configuration' : 'Add another Configuration'}
            </Button>
          </Grid>
        }

        <ConfirmationDialog
          onClose={this.onCloseConfirmation}
          title="Confirm Deletion"
          error={this.confirmationConfigError()}
          actions={this.renderConfigConfirmationActions}
          open={this.state.deleteConfigConfirmDialog.open}
        >
          <Typography>Are you sure you want to delete this NodeBalancer Configuration?</Typography>
        </ConfirmationDialog>
      </React.Fragment>
    );
  }
}

const styled = withStyles(styles, { withTheme: true });

const preloaded = PromiseLoader<CombinedProps>({
  configs: (props) => {
    const { match: { params: { nodeBalancerId } } } = props;
    return getConfigsWithNodes(nodeBalancerId!);
  },
});

export default withRouter(styled(preloaded(NodeBalancerConfigurations))) as any;
