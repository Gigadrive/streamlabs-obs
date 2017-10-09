import { PersistentStatefulService } from '../persistent-stateful-service';
import { mutation } from '../stateful-service';
import { Inject } from '../../util/injector';
import { RootNode } from './nodes/root';
import { SourcesNode } from './nodes/sources';
import { ScenesNode } from './nodes/scenes';
import { SceneItemsNode } from './nodes/scene-items';
import { TransitionNode } from './nodes/transition';
import { HotkeysNode } from './nodes/hotkeys';
import { WindowsService } from '../windows';
import namingHelpers from '../../util/NamingHelpers';
import electron from 'electron';
import { ScenesService } from '../scenes';
import { SourcesService } from '../sources';
import { E_AUDIO_CHANNELS } from '../audio';
import { throttle } from 'lodash-decorators';
import { parse } from '.';
import fs from 'fs';
import path from 'path';

const NODE_TYPES = {
  RootNode,
  SourcesNode,
  ScenesNode,
  SceneItemsNode,
  TransitionNode,
  HotkeysNode
};

const DEFAULT_SCENES_COLLECTION_NAME = 'default';


interface IScenesCollectionState {
  activeCollection: string;
  scenesCollections: string[];
}


/**
 * This class exposes the public API for saving and loading
 * the scene configuration.  This service and its supporting
 * code is responsible for mainting a strict versioned schema
 * for the config files, and handling any data migrations from
 * one version to another.
 */
export class ConfigPersistenceService extends PersistentStatefulService<IScenesCollectionState> {

  static defaultState: IScenesCollectionState = {
    activeCollection: '',
    scenesCollections: []
  };

  @Inject() scenesService: ScenesService;
  @Inject() sourcesService: SourcesService;
  @Inject() windowsService: WindowsService;

  init() {
    super.init();
    this.CLEAR_SCENES_COLLECTION();
    if (!fs.exists(this.configFileDirectory)) return;

    const configsNames = fs.readdirSync(this.configFileDirectory).map(file => file.replace(/\.[^/.]+$/, ''));
    if (configsNames.length) {
      this.ADD_SCENES_COLLECTIONS(configsNames);
    }
  }

  @throttle(5000)
  save() {
    this.rawSave();
  }


  rawSave(): Promise<void> {
    return new Promise(resolve => {
      const root = new RootNode();
      root.save().then(() => {
        this.ensureDirectory();
        fs.writeFileSync(
          this.getConfigFilePath(this.state.activeCollection),
          JSON.stringify(root, null, 2)
        );
        resolve();
      });
    });
  }


  load(configName?: string): Promise<void> {
    configName = configName || this.state.activeCollection;

    if (!this.state.scenesCollections.includes(configName)) {
      configName = DEFAULT_SCENES_COLLECTION_NAME;
    }

    return new Promise(resolve => {

      const fileExists = fs.existsSync(this.getConfigFilePath(configName));
      const data = fileExists ?
        fs.readFileSync(this.getConfigFilePath(configName)).toString() : '';

      if (!fileExists) this.createConfig(configName);

      if (data) {
        const root = parse(data, NODE_TYPES);
        root.load().then(() => {
          // Make sure we actually loaded at least one scene, otherwise
          // create the default one
          if (this.scenesService.scenes.length === 0) this.setUpDefaults();
          this.SET_ACTIVE_COLLECTION(configName);
          resolve();
        });
      } else {
        this.SET_ACTIVE_COLLECTION(configName);
        this.setUpDefaults();
        this.rawSave().then(() => resolve());
      }
    });
  }


  // Rather than having a default config file that would require
  // updating every time we change the schema, we simply put the
  // application into the desired state and save.
  setUpDefaults() {
    this.scenesService.createScene('Scene', { makeActive: true });
    this.setUpDefaultAudio();
  }


  setUpDefaultAudio() {
    this.sourcesService.createSource(
      'DesktopAudioDevice1',
      'wasapi_output_capture',
      {},
      { channel: E_AUDIO_CHANNELS.OUTPUT_1 }
    );

    this.sourcesService.createSource(
      'AuxAudioDevice1',
      'wasapi_input_capture',
      {},
      { channel: E_AUDIO_CHANNELS.INPUT_1 }
    );
  }


  createConfig(name: string): boolean {
    if (!this.isValidName(name)) return false;
    this.ensureDirectory();
    fs.writeFileSync(this.getConfigFilePath(name), '');
    this.ADD_SCENES_COLLECTIONS([name]);
    return true;
  }


  duplicateConfig(fromConfig: string, toConfig: string): Promise<void> {
    return this.rawSave().then(() => {
      this.createConfig(toConfig);
      fs.writeFileSync(
        this.getConfigFilePath(toConfig),
        fs.readFileSync(this.getConfigFilePath(fromConfig))
      );
    });
  }


  renameConfig(newName: string) {
    fs.renameSync(
      this.getConfigFilePath(this.state.activeCollection),
      this.getConfigFilePath(newName)
    );
    this.RENAME_COLLECTION(this.state.activeCollection, newName);
    this.SET_ACTIVE_COLLECTION(newName);
  }


  removeConfig(configName: string) {
    fs.unlink(this.getConfigFilePath(configName));
    this.REMOVE_COLLECTION(configName);
  }


  suggestName(name: string) {
    return namingHelpers.suggestName(name, (name: string) => this.state.scenesCollections.includes(name));
  }

  /**
   * scene collection name actually is file name
   * so we have to validate it
   */
  isValidName(name: string) {
    return /^[^\/\\\.]+$/.test(name);
  }


  private ensureDirectory() {
    if (!fs.existsSync(this.configFileDirectory)) {
      fs.mkdirSync(this.configFileDirectory);
    }
  }


  private get configFileDirectory() {
    return path.join(electron.remote.app.getPath('userData'), 'SceneConfigs');
  }


  private getConfigFilePath(configName: string) {
    // Eventually this will be changeable by the user
    return path.join(this.configFileDirectory, `${configName}.json`);
  }


  showNameConfig(options: { scenesCollectionToDuplicate?: string, rename?: boolean} = {}) {
    this.windowsService.showWindow({
      componentName: 'NameSceneCollection',
      queryParams: {
        scenesCollectionToDuplicate: options.scenesCollectionToDuplicate,
        rename: options.rename ? 'true' : ''
      },
      size: {
        width: 400,
        height: 250
      }
    });
  }


  @mutation()
  private CLEAR_SCENES_COLLECTION() {
    this.state.scenesCollections.length = 0;
  }

  @mutation()
  private ADD_SCENES_COLLECTIONS(configNames: string[]) {
    this.state.scenesCollections.push(...configNames);
  }

  @mutation()
  private SET_ACTIVE_COLLECTION(collectionName: string) {
    this.state.activeCollection = collectionName;
  }

  @mutation()
  private RENAME_COLLECTION(currentName: string, newName: string) {
    const collections = this.state.scenesCollections;
    collections.splice(collections.indexOf(currentName), 1, newName);
  }

  @mutation()
  private REMOVE_COLLECTION(name: string) {
    this.state.scenesCollections.splice(this.state.scenesCollections.indexOf(name), 1);
  }
}
