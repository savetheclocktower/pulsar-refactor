
const { CompositeDisposable } = require('atom');
const dedent = require('dedent');
const Dialog = require('./dialog');
const ApplyEdits = require('./apply-edits');
const console = require('./console');

function describeEdits (response, { pending = true } = {}) {
  if (response === null) { return ''; }
  let editCount = 0;
  let fileCount = 0;
  for (let [_, edits] of response.entries()) {
    fileCount++;
    editCount += edits.length;
  }
  return `${pending ? 'Would rename' : 'Renamed'} ${pluralize(editCount, 'instance')} in ${pluralize(fileCount, 'file')}.`;
}

function pluralize (count, singular, plural = null) {
  plural ??= `${singular}s`;
  return `${count} ${count === 1 ? singular : plural}`;
}

function describeResponse (response) {
  let { editorFiles, bufferFiles } = response.describe();

  let editorFilesList = editorFiles.map(f => `* \`${f}\``).join('\n');
  let bufferFilesList = bufferFiles.map(f => `* \`${f}\``).join('\n');

  let totalFileCount = editorFiles.length + bufferFiles.length;

  let markdown = dedent`
    Rename succeeded. ${pluralize(totalFileCount, 'file')} affected.
  `;

  if (editorFiles.length > 0) {
    markdown = dedent`
      ${markdown}

      Open files in workspace:

      ${editorFilesList}
    `;
  }

  if (bufferFiles.length > 0) {
    markdown = dedent`
      ${markdown}

      Other files:

      ${bufferFilesList}
    `;
  }

  return markdown;
}

function showNoProvidersMessage () {
  atom.notifications.addError(
    `No provider`,
    { description: `No provider is available to rename symbols in this kind of file.` }
  );
}

module.exports = {

  subscriptions: null,
  providers: [],

  activate() {
    // Events subscribed to in atom's system can be easily cleaned up with a CompositeDisposable
    this.subscriptions = new CompositeDisposable();
    this.offerUndoNotification = false;

    // Register command that toggles this view
    this.subscriptions.add(
      atom.commands.add('atom-text-editor', {
        'pulsar-refactor:rename': (event) => this.rename(event),
        'pulsar-refactor:list-all-providers': (event) => this.listAllProviders(event),
      }),
      atom.config.observe('pulsar-refactor.offerUndoNotification', bool => {
        this.offerUndoNotification = bool;
      })
    );
  },

  listAllProviders () {
    let editor = atom.workspace.getActiveTextEditor();
    let providers = this.findAllProvidersForEditor(editor);

    let scopes = new Set();
    for (let provider of providers) {
      if (!provider.grammarScopes) continue;
      for (let scope of provider.grammarScopes)
        scopes.add(scope);
    }

    let scopeList = Array.from(scopes).map(s => `* \`${s}\``).join('\n');

    let description = '';

    if (scopes.size > 0)  {
      description = dedent`
        Found ${pluralize(providers.length, 'provider')} offering rename support for the following file types:

        ${scopeList}
      `;
    }

    atom.notifications.addInfo(
      'Rename providers',
      {
        dismissable: true,
        description
      }
    );
  },

  async rename (event) {
    let editor = atom.workspace.getActiveTextEditor();
    let selections = editor.getSelections();
    if (selections.length > 1) {
      return event.abortKeyBinding();
    }
    let range;
    if (selections[0].isEmpty()) {
      range = editor.getLastCursor().getCurrentWordBufferRange();
    } else {
      range = selections[0].getBufferRange();
    }

    let provider = this.findProviderForEditor(editor);
    if (!provider) {
      showNoProvidersMessage();
      return;
    }

    if (provider.prepareRename) {
      let prepareResponse = await provider.prepareRename(editor, range.start);
      console.log('[pulsar-refactor] prepare response:', prepareResponse);

      if (prepareResponse?.start && prepareResponse?.end) {
        range = prepareResponse;
      } else if (typeof prepareResponse === 'boolean') {
        // Do nothing; our instincts about the range of the name are fine.
      } else {
        // Any other type from `response`, including `null`, means that the
        // server went wrong, and we should bail.
        // atom.notifications.addError(
        //   `Cannot rename`,
        //   {
        //     description: `Server suggests that this isn’t a valid rename location.`
        //   }
        // );
        // return;
      }
    }

    let originalText = editor.getTextInBufferRange(range);

    let dialog = new Dialog({
      initialName: originalText,
      onChange: async (text) => {
        if (text == originalText) return '';
        let response = await provider.rename(editor, range.start, text);
        if (!response) {
          throw `Invalid rename position`;
        } else {
          return describeEdits(response);
        }
      }
    });

    try {
      let name = await dialog.attach();
      let response = await this.performRename(provider, editor, range, name);

      if (!response) {
        throw new Error(`Unknown error!`);
      }

      if (this.offerUndoNotification) {
        let notification = atom.notifications.addSuccess(
          `Rename succeeded`,
          {
            dismissable: true,
            description: describeResponse(response),
            buttons: [
              {
                text: 'Undo',
                onDidClick: async () => {
                  await response.revert();
                  notification.dismissed = false;
                  notification.dismiss();
                }
              }
            ]
          }
        );

        notification.onDidDismiss(() => {
          // Whenever the notification disappears, the `RenameResponse`
          // instance can be disposed of. This is an important step because a
          // rename job likely opened several `TextBuffer`s that weren't
          // already opened for editing. We need to be able to destroy them
          // when we're done.
          response.dispose();
        });
      } else {
        // Since the user opted out of this notification, we can dispose of
        // this object immediately.
        //
        // TODO: We might still want some sort of “Undo Last Rename” command,
        // in which case we'd have to keep this object around at least until
        // the next rename job. But that's probably overkill! The user can
        // always just rename something back to what it was.
        response.dispose();
      }
    } catch (err) {
      if (err.name === 'DialogCancelError') return;
      console.error(err);
    }
  },

  async performRename (provider, editor, range, newText) {
    let response = await provider.rename(editor, range.start, newText);
    console.log('[pulsar-refactor] rename response:', response);

    if (!response) {
      atom.notifications.addError(
        `Rename attempt failed`,
        { description: `Language server returned invalid response.` }
      );
      return false;
    }

    let result = await ApplyEdits.execute(response);
    result.response = response;
    return result;
  },

  deactivate() {
    this.modalPanel?.destroy();
    this.subscriptions.dispose();
    this.pulsarRefactorView?.destroy();
  },

  toggle() {
    return (
      this.modalPanel.isVisible() ?
      this.modalPanel.hide() :
      this.modalPanel.show()
    );
  },

  findProviderForEditor (editor) {
    let scope = editor.getGrammar()?.scopeName;
    if (!scope) return null;

    let result;
    for (let provider of this.providers) {
      if (!provider.grammarScopes?.includes(scope)) continue;
      if (!result || provider.priority > result.priority) {
        result = provider;
      }
    }
    return result;
  },

  findAllProvidersForEditor (editor) {
    let scope = editor.getGrammar()?.scopeName;
    if (!scope) return null;

    let results = [];
    for (let provider of this.providers) {
      if (!provider.grammarScopes?.includes(scope)) continue;
      results.push(provider);
    }
    results.sort((a, b) => b.priority - a.priority);
    return results;
  },

  consumeRefactor (...providers) {
    console.log('[pulsar-refactor] consumeRefactor:', ...providers);
    this.providers.push(...providers);
  },

  consumeRefactorWithPrepare (...providers) {
    // TODO: Decide how to handle this. The contract for the enhanced service
    // _allows_ for a “prepare” phase, but it does not _require_ one. So it may
    // make more sense just to fold this path into the `consumeRefactor` method.
    this.providers.push(...providers);
  }
};
