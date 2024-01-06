const { TextBuffer } = require('atom');

const MARKER_LAYERS_FOR_EDITORS = new WeakMap();
const MARKER_LAYERS_FOR_BUFFERS = new WeakMap();

function findOrCreateMarkerLayerForEditor (editor) {
  let layer = MARKER_LAYERS_FOR_EDITORS.get(editor);
  if (!layer) {
    layer = editor.addMarkerLayer({ maintainHistory: true });
    MARKER_LAYERS_FOR_EDITORS.set(editor, layer);
  }
  return layer;
}

function findOrCreateMarkerLayerForBuffer (buffer) {
  let layer = MARKER_LAYERS_FOR_BUFFERS.get(buffer);
  if (!layer) {
    layer = buffer.addMarkerLayer({ maintainHistory: true });
    MARKER_LAYERS_FOR_BUFFERS.set(buffer, layer);
  }
  return layer;
}

function isTextEditor (item) {
  return item.constructor.name === 'TextEditor';
}

function findFirstEditorForPath(path) {
  let panes = atom.workspace.getPanes()
  for (let pane of panes) {
    for (let item of pane.getItems()) {
      if (!isTextEditor(item)) continue
      if (item.getPath() === path) {
        return item
      }
    }
  }
  return null
}

class RenameResponse {
  constructor() {
    this.editorCheckpointIndex = new Map();
    this.bufferCheckpointIndex = new Map();

    this.editorSaveSettings = new Map();

    this.unsavedEditors = 0;
  }

  dispose () {
    this.editorCheckpointIndex.clear();
    this.bufferCheckpointIndex.clear();
    this.editorSaveSettings.clear();

    for (let buffer of this.bufferCheckpointIndex.keys()) {
      buffer.destroy();
    }
  }

  addEditorCheckpoint (editor, checkpoint, shouldSave = false) {
    let existed = this.editorCheckpointIndex.has(editor);
    this.editorCheckpointIndex.set(editor, checkpoint);
    this.editorSaveSettings.set(editor, shouldSave);
    if (!shouldSave && !existed) this.unsavedEditors++;
  }

  addBufferCheckpoint (buffer, checkpoint) {
    this.bufferCheckpointIndex.set(buffer, checkpoint);
  }

  relativizePath (filePath) {
    let [_, relative] = atom.project.relativizePath(filePath);
    return relative;
  }

  describe () {
    let editorFiles = [...this.editorCheckpointIndex.keys()];
    editorFiles = editorFiles.map(e => this.relativizePath(e.getPath()));

    let bufferFiles = [...this.bufferCheckpointIndex.keys()];
    bufferFiles = bufferFiles.map(b => this.relativizePath(b.getPath()));

    return {
      editorFiles,
      bufferFiles,
      unsavedEditors: this.unsavedEditors
    };
  }

  async revert () {
    let promises = [];
    // Either we didn't succeed or the user clicked on “Undo.” Let's revert the
    // changes we made.
    for (let [editor, checkpoint] of this.editorCheckpointIndex) {
      let shouldSave = this.editorSaveSettings.get(editor);
      editor.revertToCheckpoint(checkpoint);
      if (shouldSave) promises.push(editor.save());
    }

    for (let [buffer, checkpoint] of this.bufferCheckpointIndex) {
      buffer.revertToCheckpoint(checkpoint);
      promises.push(buffer.save());
    }

    return Promise.all(promises);
  }
}


const ApplyEdits = {
  // Applies the given edits to a `TextEditor` instance that is present in the
  // workspace.
  applyEditsToOpenEditor (editor, edits) {
    let buffer = editor.getBuffer();
    const checkpoint = buffer.createCheckpoint();
    try {
      let layer = findOrCreateMarkerLayerForEditor(editor);
      let markerMap = new Map();
      for (let edit of edits) {
        let marker = layer.markBufferRange(edit.oldRange);
        markerMap.set(edit, marker);
      }

      for (let edit of edits) {
        let marker = markerMap.get(edit);
        if (!marker) throw new Error(`Marker missing range!`);
        buffer.setTextInRange(marker.getBufferRange(), edit.newText);
      }
      buffer.groupChangesSinceCheckpoint(checkpoint);
      return checkpoint;
    } catch (err) {
      buffer.revertToCheckpoint(checkpoint);
      throw err;
    }
  },

  // Applies the given edits to a `TextBuffer` instance representing a file
  // that is not currently open in the workspace.
  applyEditsToUnopenBuffer (buffer, edits) {
    const checkpoint = buffer.createCheckpoint();
    try {
      let layer = findOrCreateMarkerLayerForBuffer(buffer);
      let markerMap = new Map();
      for (let edit of edits) {
        let marker = layer.markRange(edit.oldRange);
        markerMap.set(edit, marker);
      }

      for (let edit of edits) {
        let marker = markerMap.get(edit);
        if (!marker) throw new Error(`Marker missing range!`);
        buffer.setTextInRange(marker.getRange(), edit.newText);
      }
      buffer.groupChangesSinceCheckpoint(checkpoint);
      return checkpoint;
    } catch (err) {
      buffer.revertToCheckpoint(checkpoint);
      throw err;
    }
  },

  getScopedSettingsForKey(key, editor) {
    let schema = atom.config.getSchema(key);
    if (!schema) {
      throw new Error(`Unknown config key: ${schema}`);
    }

    let grammar = editor.getGrammar();
    let base = atom.config.get(key);
    let scoped = atom.config.get(key, { scope: [grammar.scopeName] });

    if (schema?.type === 'object') {
      return { ...base, ...scoped };
    } else {
      return scoped ?? base;
    }
  },

  async execute (fileMap) {
    let openFiles = new Map();
    let otherFiles = new Set();

    let renameResponse = new RenameResponse();

    let files = fileMap.keys();
    for (let path of files) {
      if (openFiles.has(path) || otherFiles.has(path)) continue;
      let editor = findFirstEditorForPath(path);
      if (editor) {
        openFiles.set(path, editor);
      } else {
        otherFiles.add(path);
      }
      // TODO: Guard against nonexistent files.
    }

    let promises = [];

    for (let [path, edits] of fileMap.entries()) {
      if (openFiles.has(path)) {
        let editor = openFiles.get(path);
        // We want to let the user opt into a scope-specific setting here, as
        // weird as that may be. So we'll make this decision on a per-editor
        // basis.
        let saveAfterEditInOpenBuffers = this.getScopedSettingsForKey(
          'pulsar-refactor.saveAfterEditInOpenBuffers',
          editor
        );
        let shouldSave = !editor.isModified() && saveAfterEditInOpenBuffers;
        let checkpoint = this.applyEditsToOpenEditor(editor, edits);
        if (shouldSave) editor.save();
        renameResponse.addEditorCheckpoint(editor, checkpoint, shouldSave);
      } else if (otherFiles.has(path)) {
        let promise = TextBuffer.load(path)
          .then(buffer => {
            let checkpoint = this.applyEditsToUnopenBuffer(buffer, edits);
            renameResponse.addBufferCheckpoint(buffer, checkpoint);
            return buffer.save();
          });

        promises.push(promise);
      }
    }

    try {
      await Promise.all(promises);

      return renameResponse;
    } catch (error) {
      await renameResponse.revert();
      renameResponse.dispose();
      throw error;
    }
  }
};

module.exports = ApplyEdits;
