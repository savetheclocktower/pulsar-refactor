const {
  CompositeDisposable,
  Disposable,
  Emitter,
  TextEditor
} = require('atom');

const el = require('./element-builder');

class DialogCancelError extends Error {
  constructor (message) {
    super(message);
    this.name = 'DialogCancelError';
  }
}

class Dialog {
  constructor({
    iconClass = null,
    initialName = '',
    prompt = 'Enter the new symbol name.',
    onChange = () => {}
  }) {
    this.emitter = new Emitter();
    this.disposables = new CompositeDisposable();
    this.miniEditor = new TextEditor({ mini: true });
    let blurHandler = () => { if (document.hasFocus()) this.close(); }
    this.miniEditor.element.addEventListener('blur', blurHandler);
    this.onChange = onChange;

    this.disposables.add(
      new Disposable(() => {
        this.miniEditor.element.removeEventListener('blur', blurHandler)
      }),
      this.miniEditor.onDidStopChanging(
        () => {
          let status = onChange(this.miniEditor.getText());
          this.clearError();
          if (status.then) {
            status
              .then(msg => this.showStatus(msg || ''))
              .catch(err => this.showError(err));
          } else {
            this.showStatus(status || '');
          }
        }
      ),
      this.miniEditor.onDidChange(() => this.showError())
    );

    this._resolves = [];
    this._rejects = [];

    this.errorMessage = el('div.error-message');
    this.statusMessage = el('div.status-message');

    let iconClassStr = iconClass ? `.${iconClass}` : ''

    this.element = el('div.pulsar-refactor-dialog',
      el(`label.icon${iconClassStr}`, prompt),
      this.miniEditor.element,
      this.statusMessage,
      this.errorMessage
    );

    atom.commands.add(this.element, {
      'core:confirm': () => {
        this.onConfirm(this.miniEditor.getText())
      },
      'core:cancel': () => this.cancel()
    });

    this.miniEditor.setText(initialName);
    this.miniEditor.selectAll();
  }

  attach () {
    this.panel = atom.workspace.addModalPanel({ item: this });
    this.miniEditor.element.focus();
    this.miniEditor.scrollToCursorPosition();

    let promise = new Promise((_resolve, _reject) => {
      this._resolves.push(_resolve);
      this._rejects.push(_reject);
    });
    return promise;
  }

  close () {
    let panel = this.panel;
    this.panel = null;
    panel?.destroy();
    this.emitter.dispose();
    this.disposables.dispose();
    this.miniEditor.destroy();
    let activePane = atom.workspace.getCenter().getActivePane();
    if (!activePane.isDestroyed()) activePane.activate();
  }

  onConfirm (newName) {
    this.close();
    while (this._resolves.length > 0) {
      let resolve = this._resolves.shift();
      resolve(newName);
    }
  }

  cancel () {
    this.close();
    while (this._rejects.length > 0) {
      let reject = this._rejects.shift();
      reject(new DialogCancelError(`User canceled rename`));
    }
  }

  showStatus (message = '') {
    this.statusMessage.textContent = message;
  }

  clearStatus () {
    if (!this.statusMessage.textContent) return;
    this.statusMessage.textContent = '';
  }

  showError (message = '') {
    this.errorMessage.textContent = message;
    if (message) {
      this.clearStatus();
      this.element.classList.add('error');
      setTimeout(
        () => this.element.classList.remove('error'),
        3000
      );
    }
  }

  clearError () {
    if (!this.errorMessage.textContent) return;
    this.errorMessage.textContent = '';
  }
}

module.exports = Dialog;
