/*
Copyright 2020 Adobe. All rights reserved.
This file is licensed to you under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License. You may obtain a copy
of the License at http://www.apache.org/licenses/LICENSE-2.0
Unless required by applicable law or agreed to in writing, software distributed under
the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR REPRESENTATIONS
OF ANY KIND, either express or implied. See the License for the specific language
governing permissions and limitations under the License.
*/

const BaseCommand = require('../../BaseCommand')
const { CONSOLE_CONFIG_KEY, getProjectCredentialType } = require('../../lib/import-helper')
const { importConsoleConfig, downloadConsoleConfigToBuffer } = require('../../lib/import')
const { Flags } = require('@oclif/core')
const inquirer = require('inquirer')
const config = require('@adobe/aio-lib-core-config')
const { EOL } = require('os')
const { warnIfOverwriteServicesInProductionWorkspace } = require('../../lib/app-helper')
const path = require('path')
const { ENTP_INT_CERTS_FOLDER } = require('../../lib/defaults')
const aioLogger = require('@adobe/aio-lib-core-logging')('@adobe/aio-cli-plugin-app:use', { provider: 'debug' })
const chalk = require('chalk')

const LibConsoleCLI = require('@adobe/aio-cli-lib-console')

class Use extends BaseCommand {
  async run () {
    const { flags, args } = await this.parse(Use)

    flags.workspace = flags.workspace || flags['workspace-name'] || ''

    aioLogger.debug(`args: ${JSON.stringify(args, null, 2)}, flags: ${JSON.stringify(flags, null, 2)}`)

    // some additional checks and updates of flags and args on top of what oclif provides
    this.additionalArgsFlagsProcessing(args, flags)
    aioLogger.debug(`After processing - args: ${JSON.stringify(args, null, 2)}, flags: ${JSON.stringify(flags, null, 2)}`)

    // make sure to prompt on stderr
    const prompt = inquirer.createPromptModule({ output: process.stderr })

    // load local config
    const currentConfig = this.loadCurrentConfiguration()
    const currentConfigString = this.configString(currentConfig)
    const currentConfigIsComplete = this.isCompleteConfig(currentConfig)
    this.log(`You are currently in:${EOL}${currentConfigString}${EOL}`)

    if (args.config_file_path) {
      const consoleConfig = await importConsoleConfig(args.config_file_path, flags)
      this.finalLogMessage(consoleConfig)
      return
    }

    // init console CLI sdk consoleCLI
    // NOTE: the user must be able to login now
    const consoleCLI = await this.getLibConsoleCLI()

    // load global console config
    const globalConfig = this.loadGlobalConfiguration()
    const globalConfigString = this.configString(globalConfig, 4)

    // load from global configuration or select workspace ?
    const globalOperationFromFlag = flags.global ? 'global' : null
    const workspaceOperationFromFlag = flags.workspace ? 'workspace' : null
    // did the user specify --global or --workspace
    // Note: global workspace(-name) flags are exclusive (see oclif flags options)
    let useOperation = globalOperationFromFlag || workspaceOperationFromFlag
    // if operation was not specified via flags we need to prompt the user for it
    if (!useOperation) {
      useOperation = await this.promptForUseOperation(prompt, globalConfigString)
    }

    // load the new workspace, project, org config
    let newConfig
    if (useOperation === 'global') {
      if (!this.isCompleteConfig(globalConfig)) {
        const message = `Your global Console configuration is incomplete.${EOL}` +
        'Use the `aio console` commands to select your Organization, Project, and Workspace.'
        this.error(message)
      }
      newConfig = globalConfig
    } else {
      // useOperation = 'workspace'
      if (!currentConfigIsComplete) {
        this.error(
          'Incomplete .aio configuration. Cannot select a new Workspace in same Project.' + EOL +
          'Please import a valid Adobe Developer Console configuration file via `aio app use <config>.json`.'
        )
      }
      const workspace = await this.selectTargetWorkspaceInProject(
        consoleCLI,
        currentConfig,
        flags
      )
      newConfig = {
        ...currentConfig,
        workspace
      }
    }

    // get supported org services
    const supportedServices = await consoleCLI.getEnabledServicesForOrg(newConfig.org.id)

    // only sync services if the current configuration is complete
    if (currentConfigIsComplete) {
      // get project credential type
      const projectCredentialType = getProjectCredentialType(currentConfig, flags)

      await this.syncServicesToTargetWorkspace(consoleCLI, prompt, currentConfig, newConfig, supportedServices, flags, projectCredentialType)
    }

    // download the console configuration for the newly selected org, project, workspace
    const buffer = await downloadConsoleConfigToBuffer(consoleCLI, newConfig, supportedServices)

    const consoleConfig = await importConsoleConfig(buffer, flags)
    this.finalLogMessage(consoleConfig)
  }

  additionalArgsFlagsProcessing (args, flags) {
    if (args.config_file_path &&
      (flags.workspace || flags.global)
    ) {
      this.error('Flags \'--workspace\' and \'--global\' cannot be used together with arg \'config_file_path\'.')
    }
    if (flags['no-input']) {
      if (!args.config_file_path && !flags.workspace && !flags.global) {
        this.error('Flag \'--no-input\', requires one of: arg \'config_file_path\', flag \'--workspace\' or flag \'--global\'')
      }
      flags['no-service-sync'] = !flags['confirm-service-sync']
      flags.merge = !flags.overwrite
    }
  }

  loadCurrentConfiguration () {
    const projectConfig = config.get('project') || {}
    const org = (projectConfig.org && { id: projectConfig.org.id, name: projectConfig.org.name }) || {}
    const project = { name: projectConfig.name, id: projectConfig.id }
    const workspace = (projectConfig.workspace && { ...projectConfig.workspace }) || {}
    return { org, project, workspace }
  }

  loadGlobalConfiguration () {
    return config.get(CONSOLE_CONFIG_KEY) || {}
  }

  configString (config, spaces = 0) {
    const { org = {}, project = {}, workspace = {} } = config
    const list = [
      `1. Org: ${org.name || '<no org selected>'}`,
      `2. Project: ${project.name || '<no project selected>'}`,
      `3. Workspace: ${workspace.name || '<no workspace selected>'}`
    ]

    return list
      .map(line => ' '.repeat(spaces) + line)
      .join(EOL)
  }

  async promptForUseOperation (prompt, globalConfigString) {
    const op = await prompt([
      {
        type: 'list',
        name: 'res',
        message: 'Switch to a new Adobe Developer Console configuration:',
        choices: [
          { name: `A. Use the global Org / Project / Workspace configuration:${EOL}${globalConfigString}`, value: 'global' },
          { name: 'B. Switch to another Workspace in the current Project', value: 'workspace' }
        ]
      }
    ])
    return op.res
  }

  isCompleteConfig (config) {
    return config &&
      config.org && config.org.id && config.org.name &&
      config.project && config.project.id && config.project.name &&
      config.workspace && config.workspace.id && config.workspace.name
  }

  /**
   * @param {LibConsoleCLI} consoleCLI lib console config
   * @param {object} config local configuration
   * @param {object} flags input flags
   * @returns {Buffer} the Adobe Developer Console configuration file for the workspace
   */
  async selectTargetWorkspaceInProject (consoleCLI, config, flags) {
    const { project, org } = config
    const workspaceNameOrId = flags.workspace

    // retrieve all workspaces
    const workspaces = await consoleCLI.getWorkspaces(
      org.id,
      project.id
    )
    let workspace
    let workspaceData = { name: workspaceNameOrId }
    // does not prompt if workspaceNameOrId is defined via the flag
    workspace = await consoleCLI.promptForSelectWorkspace(workspaces, { workspaceId: workspaceNameOrId, workspaceName: workspaceNameOrId }, { allowCreate: true })
    if (!workspace) {
      aioLogger.debug(`--workspace=${workspaceNameOrId} was not found in the current Project ${project.name}`)
      if (workspaceNameOrId) {
        if (!flags['confirm-new-workspace']) {
          const shouldNewWorkspace = await consoleCLI.prompt.promptConfirm(`Workspace '${workspaceNameOrId}' does not exist \n > Do you wish to create a new workspace?`)
          if (!shouldNewWorkspace) {
            this.error('Workspace creation aborted')
          }
        }
      } else {
        workspaceData = await consoleCLI.promptForCreateWorkspaceDetails()
      }
      aioLogger.debug(`Creating workspace: ${workspaceData.name}`)
      workspace = await consoleCLI.createWorkspace(org.id, project.id, workspaceData)
    }
    return {
      name: workspace.name,
      id: workspace.id
    }
  }

  /**
   * @param {LibConsoleCLI} consoleCLI lib console config
   * @private
   */
  async syncServicesToTargetWorkspace (consoleCLI, prompt, currentConfig, newConfig, supportedServices, flags, projectCredentialType) {
    if (flags['no-service-sync']) {
      console.error('Skipping Services sync as \'--no-service-sync=true\'')
      console.error('Please verify Service subscriptions manually for the new Org/Project/Workspace configuration.')
      return
    }
    const currentServiceProperties = await consoleCLI.getServicePropertiesFromWorkspaceWithCredentialType({
      orgId: currentConfig.org.id,
      projectId: currentConfig.project.id,
      workspace: currentConfig.workspace,
      supportedServices,
      credentialType: projectCredentialType
    })
    const serviceProperties = await consoleCLI.getServicePropertiesFromWorkspaceWithCredentialType({
      orgId: newConfig.org.id,
      projectId: newConfig.project.id,
      workspace: newConfig.workspace,
      supportedServices,
      credentialType: projectCredentialType
    })

    // service subscriptions are same
    if (this.equalSets(
      new Set(currentServiceProperties.map(s => s.sdkCode)),
      new Set(serviceProperties.map(s => s.sdkCode))
    )) {
      return
    }

    // Note: this does not handle different product profiles for same service subscriptions yet

    const newWorkspaceName = newConfig.workspace.name
    const newProjectName = newConfig.project.name
    const currentProjectName = currentConfig.project.name

    // service subscriptions are different
    console.error(
      chalk.yellow('⚠ Services attached to the target Workspace do not match Service subscriptions in the current Workspace.')
    )

    // if org is different, sync is more complex as we would need to check if the target
    // org supports the services attached in the current workspace, for now defer to
    // manual selection
    if (currentConfig.org.id !== newConfig.org.id) {
      console.error(chalk.yellow(
        `⚠ Target Project '${newProjectName}' is in a different Org than the current Project '${currentProjectName}.'`
      ))
      console.error(chalk.yellow(
        '⚠ Services cannot be synced across Orgs, please make sure to subscribe' +
        ' to missing Services manually in the Adobe Developer Console.'
      ))
      return
    }

    // go on with sync, ensure user is aware of what where are doing
    console.error(`The '${newWorkspaceName}' Workspace in Project '${newProjectName}' subscribes to the following Services:`)
    console.error(JSON.stringify(serviceProperties.map(s => s.name), null, 2))
    console.error(
      'Your project requires the following Services based on your current Project / Workspace configuration:' +
      `${EOL}${JSON.stringify(currentServiceProperties.map(s => s.name), null, 2)}`
    )

    if (!flags['confirm-service-sync']) {
      // ask for confirmation, overwriting service subscriptions is a destructive
      // operation, especially if done in Production
      warnIfOverwriteServicesInProductionWorkspace(newProjectName, newWorkspaceName)
      const confirm = await prompt([{
        type: 'confirm',
        name: 'res',
        message:
          `${EOL}Do you want to sync and update Services for Workspace '${newWorkspaceName}' in Project '${newProjectName}' now ?`
      }])

      if (!confirm.res) {
        // abort service sync
        console.error('Service will not be synced, make sure to manually add missing Services from the Developer Console.')
        return
      }
    }

    await consoleCLI.subscribeToServicesWithCredentialType({
      orgId: newConfig.org.id,
      project: newConfig.project,
      workspace: newConfig.workspace,
      certDir: path.join(this.config.dataDir, ENTP_INT_CERTS_FOLDER),
      serviceProperties: currentServiceProperties,
      credentialType: projectCredentialType
    })

    console.error(`✔ Successfully updated Services in Project ${newConfig.project.name} and Workspace ${newConfig.workspace.name}.`)
  }

  async finalLogMessage (consoleConfig) {
    const config = { org: consoleConfig.project.org, project: consoleConfig.project, workspace: consoleConfig.project.workspace }
    const configString = this.configString(config)
    this.log(chalk.green(chalk.bold(
      `${EOL}✔ Successfully imported configuration for:${EOL}${configString}.`
    )))
  }

  equalSets (setA, setB) {
    if (setA.size !== setB.size) {
      return false
    }
    for (const a of setA) {
      if (!setB.has(a)) {
        return false
      }
    }
    return true
  }
}

Use.description = `Import an Adobe Developer Console configuration file.

If the optional configuration file is not set, this command will retrieve the console org, project, and workspace settings from the global config.

To set these global config values, see the help text for 'aio console --help'.

To download the configuration file for your project, select the 'Download' button in the toolbar of your project's page in https://console.adobe.io
`

Use.flags = {
  ...BaseCommand.flags,
  overwrite: Flags.boolean({
    description: 'Overwrite any .aio and .env files during import of the Adobe Developer Console configuration file',
    default: false,
    exclusive: ['merge']
  }),
  merge: Flags.boolean({
    description: 'Merge any .aio and .env files during import of the Adobe Developer Console configuration file',
    default: false,
    exclusive: ['overwrite']
  }),
  global: Flags.boolean({
    description: 'Use the global Adobe Developer Console Org / Project / Workspace configuration, which can be set via `aio console` commands',
    default: false,
    char: 'g',
    exclusive: ['workspace']
  }),
  workspace: Flags.string({
    description: 'Specify the Adobe Developer Console Workspace name or Workspace id to import the configuration from',
    default: '',
    char: 'w',
    exclusive: ['global', 'workspace-name']
  }),
  'confirm-new-workspace': Flags.boolean({
    description: 'Skip and confirm prompt for creating a new workspace',
    default: false
  }),
  'workspace-name': Flags.string({
    description: '[DEPRECATED]: please use --workspace instead',
    default: '',
    char: 'w',
    exclusive: ['global', 'workspace']
  }),
  'no-service-sync': Flags.boolean({
    description: 'Skip the Service sync prompt and do not attach current Service subscriptions to the new Workspace',
    default: false,
    exclusive: ['confirm-service-sync']
  }),
  'confirm-service-sync': Flags.boolean({
    description: 'Skip the Service sync prompt and overwrite Service subscriptions in the new Workspace with current subscriptions',
    default: false,
    exclusive: ['no-service-sync']
  }),
  'no-input': Flags.boolean({
    description: 'Skip user prompts by setting --no-service-sync and --merge. Requires one of config_file_path or --global or --workspace',
    default: false
  }),
  'use-jwt': Flags.boolean({
    description: 'if the config has both jwt and OAuth Server to Server Credentials (while migrating), prefer the JWT credentials',
    default: false
  })
}

Use.args = [
  {
    name: 'config_file_path',
    description: 'path to an Adobe I/O Developer Console configuration file',
    required: false
  }
]

module.exports = Use
