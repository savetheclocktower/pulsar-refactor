
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

  // Accepts a list of providers and a function. Visits each provider in turn
  // and runs the function against each one until we receive a non-`null`
  // response, then returns a provider/result tuple.
  //
  // This allows us to fall back to the next-highest-priority provider if our
  // initial pick didn't give us a valid response.
  async getFirstValidResponseFromProviders(providers, fn) {
    for (let provider of providers) {
      let response = await fn.call(this, provider);
      if (response !== null) {
        return [provider, response];
      }
    }
    return [null, null];
  },

  async rename (event) {
    let editor = atom.workspace.getActiveTextEditor();
    let selections = editor.getSelections();
    if (selections.length > 1) {
      return event.abortKeyBinding();
    }
    let range;
    // Which range will be renamed? If there's a selection, start with that
    // exact range; otherwise get the range of the word under the cursor.
    //
    // Either way, this range might be altered if the server supports
    // `textDocument/prepareRename` and suggests a different range.
    if (selections[0].isEmpty()) {
      range = editor.getLastCursor().getCurrentWordBufferRange();
    } else {
      range = selections[0].getBufferRange();
    }

    let allProviders = this.findAllProvidersForEditor(editor);
    if (allProviders.length === 0) {
      showNoProvidersMessage();
      return;
    }

    // For now, let's pluck out the providers that support `provideRename` and
    // try them first, regardless of ordering. (Might be worth adding a setting
    // for this.)
    let renameProviders = allProviders.filter(p => !!p.prepareRename);
    console.debug(`All providers:`, allProviders);
    console.debug(`Rename providers:`, renameProviders);

    let provider = null;
    let result;
    if (renameProviders.length > 0) {
      // We have at least one provider that supports `prepareRename`, so we'll
      // try these candidates first. If any one of them works, that's the
      // provider we'll use for this task.
      [provider, result] = await this.getFirstValidResponseFromProviders(
        renameProviders,
        async (provider) => {
          return provider.prepareRename(editor, range.start);
        }
      );
      // `getFirstValidResponseFromProviders` guarantees that `provider` is
      // only non-null when the response we got from that provider is non-null.
      if (provider) {
        console.debug(
          'Got a result:',
          result,
          'from provider:',
          provider,
          ', hence will use this provider later'
        );
      }
      if (result?.start && result?.end) {
        range = result;
      }
    }

    let originalText = editor.getTextInBufferRange(range);

    // Build a simple dialog allowing the user to input the new name.
    let dialog = new Dialog({
      // TODO: `prepareRename` can specify a `placeholder` option, but our
      // service contract needs to be improved for us to be able to use it.
      initialName: originalText,
      onChange: async (text) => {
        // Bail early in these cases rather than confuse the provider.
        if (text === '') return '';
        if (text == originalText) return '';

        // When we ask a provider to rename something, we're really just asking
        // it which ranges would _need_ to be renamed. We're the ones who are
        // in charge of performing the edits, so we can treat any rename
        // request as a dry run.
        //
        // That's what we're doing here; we're only asking the server about it
        // so that we can tell the user about how many files and locations
        // would be affected.
        //
        // TODO: If this “preliminary” rename request results in an error for
        // given input, it means that the _actual_ rename request will fail for
        // that input, since the two calls are identical. We can therefore
        // safely disable submission until the user changes the input. If done
        // right, this would guarantee that any successful submission of this
        // dialog would result in a successful renaming.
        let response;
        if (provider) {
          // If we had a successful `prepareRename` from a given provider
          // earlier, keep using that provider.
          response = await provider.rename(editor, range.start, text);
        } else {
          // At this point, we're no longer privileging providers that support
          // `prepareRename`; try the providers in the order we originally
          // ranked them.
          [, response] = await this.getFirstValidResponseFromProviders(
            allProviders,
            async (provider) => {
              return await provider.rename(editor, range.start, text);
            }
          );
        }

        console.debug(`Preliminary rename response:`, response);

        if (!response) {
          // Why would the response be `null` here? Other than the `atom-ide`
          // type definitions, there's not much documentation about what the
          // intent was. I can only assume that `null` is meant to cover all
          // possible failure cases.
          //
          // Here are some theoretical reasons why this could be `null`:
          //
          // * Because of a bug elsewhere, it could be that the provider claims
          //   to support refactoring, but doesn’t actually support it.
          //
          // That doesn't tell me much! It doesn't tell me if the error is
          // doomed to happen in all cases or just when the input isn't valid.
          // (`typescript-language-server` will happily let me rename any
          // identifier to an invalid name or any other string of gibberish,
          // but the LSP spec envisions that a language server could return an
          // error if, e.g., the edit would result in a compilation failure.)
          //
          // TODO: A future version of the `refactor` service should add the
          // ability to show a provider-specified error message in our UI.
          throw `Unknown error`;
        } else {
          return describeEdits(response);
        }
      }
    });

    try {
      let name = await dialog.attach();
      let [, response] = await this.getFirstValidResponseFromProviders(
        // If `provider` is present, it's the one we used earlier for
        // `prepareRename`.
        provider ? [provider] : allProviders,
        async (provider) => {
          return await provider.rename(editor, range.start, name);
        }
      )
      console.debug('Rename response:', response);

      // Apply the edits.
      let renameResponse = await this.performRename(response);

      if (!response) {
        atom.notifications.addError(
          `Rename attempt failed`,
          { description: `Language server returned invalid response.` }
        );
        throw new Error(`Rename attempt failed!`);
      }

      if (this.offerUndoNotification) {
        let notification = atom.notifications.addSuccess(
          `Rename succeeded`,
          {
            dismissable: true,
            description: describeResponse(renameResponse),
            buttons: [
              {
                text: 'Undo',
                onDidClick: async () => {
                  await renameResponse.revert();
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
          renameResponse.dispose();
        });
      } else {
        // Since the user opted out of this notification, we can dispose of
        // this object immediately.
        //
        // TODO: We might still want some sort of “Undo Last Rename” command,
        // in which case we'd have to keep this object around at least until
        // the next rename job. But that's probably overkill! The user can
        // always just rename something back to what it was.
        renameResponse.dispose();
      }
    } catch (err) {
      if (err.name === 'DialogCancelError') return;
      console.error(err);

      atom.notifications.addError(
        `Rename error`,
        {
          detail: err.message,
          stack: err.stack
        }
      );
    }
  },

  async performRename (response) {
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

  getScoreForProvider (provider) {
    let score = provider.priority;
    // A provider that supports `prepareRename` should be preferred over one
    // that does not, all else being equal.
    return provider.prepareRename ? score + 0.001 : score;
  },

  compareProviders(a, b) {
    let scoreA = this.getScoreForProvider(a);
    let scoreB = this.getScoreForProvider(b);
    return scoreB - scoreA;
  },

  findProviderForEditor (editor) {
    let scope = editor.getGrammar()?.scopeName;
    if (!scope) return null;

    let result;
    for (let provider of this.providers) {
      if (!provider.grammarScopes?.includes(scope)) continue;
      if (!result || this.compareProviders(provider, result) < 0) {
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
    results.sort((a, b) => this.compareProviders(a, b));
    return results;
  },

  consumeRefactor (...providers) {
    console.log('Consuming refactor provider(s):', ...providers);
    this.providers.push(...providers);
  },

  consumeRefactorWithPrepare (...providers) {
    // TODO: Decide how to handle this. The contract for the enhanced service
    // _allows_ for a “prepare” phase, but it does not _require_ one. So it may
    // make more sense just to fold this path into the `consumeRefactor` method.
    this.providers.push(...providers);
  }
};
