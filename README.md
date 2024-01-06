# pulsar-refactor

A package for performing project-wide renames of symbols.

Requires a package [that provides the `refactor` service](https://web.pulsar-edit.dev/packages?serviceType=provided&service=refactor). Few IDE backend packages provide this service,  but most of them just need a quick update! If you want your favorite IDE backend package to support this, open an issue and we’ll see what we can do.

(If you’re the author of an IDE backend package, see below.)

## Frequently asked questions

### How does it work?

Place your cursor on a symbol that you’d like to rename.

Invoke the **Refactor: Rename** command.

Your IDE background package will tell us if it knows how to rename that symbol. If so, a dialog will appear:

<p><img width="598" alt="Screenshot 2024-01-06 at 2 21 45 PM" src="https://github.com/pulsar-edit/pulsar/assets/3450/db4c344d-9331-4a2a-bf06-430ca34e90d3"></p>

Edit the name of the symbol and press <kbd>Return</kbd>. The renaming proceeds in a manner similar to that of a project-wide find-and-replace:

* All references to that symbol in **open editors** — files that you already had open in your workspace — will be renamed. By default, these changes will not be committed to disk automatically.

  If `saveAfterEditInOpenBuffers` is enabled, this package will automatically save each editor after a rename operation _if_ said editor was unmodified — i.e., its contents matched the contents on disk. (This package will never automatically save a buffer for which there are unrelated pending changes.)

* All references to that symbol in **unopened editors** — files that were not opened for editing in your workspace — wil be renamed and **immediately saved**.

* If `offerUndoNotification` is enabled, you’ll see a post-rename notification that describes which files were touched and offers an <kbd>Undo</kbd> button just in case you regret your course of action.

### Why is this package renaming things in [subjective manner X] instead of in [subjective manner Y]?

Because that’s what the language server told us to do. Take it up with your IDE backend package!

### Why is this package trying to rename files in a place it shouldn’t?

If this package is doing weird things, like trying to touch files in `node_modules` or in other ignored paths… again, it’s because that’s what the language server instructed us to do.

We trust that the language server knows what it’s doing. The set of changes required to rename a symbol from X to Y is _atomic_, and we’re not entitled to ignore any of those edits without introducing errors into the process.

## Technical details for IDE backend package implementers

### A history lesson

I resurrected the `refactor` service from the original version, apparently called `nuclide-refactor`. That service [never got past version `0.0.0`](https://github.com/facebookarchive/atom-ide-ui/blob/710f8477607d3788aeadcbdd55079925241ce40d/modules/atom-ide-ui/pkg/atom-ide-refactor/package.json). After Nuclide was retired, most of the `atom-ide-ui` functionality got spun off into standalone packages, but not refactoring.

Still, `atom-languageclient` has supported rename refactors [since 2019](https://github.com/atom/atom-languageclient/pull/270) — yet only one IDE backend package on the repo has ever actually declared itself as a _provider_ of `nuclide-refactor`, and even that one remarked at [how obscure the feature seemed to be](https://github.com/ayame113/atom-ide-deno/blob/main/package.json#L141).

So why haven’t any other packages — not even `ide-typescript`, whose language server has supported `textDocument/rename` since the beginning! — provided `nuclide-refactor`, a service that `atom-languageclient` makes available for free? Possibly because there wasn’t ever a standalone Atom package that consumed it, or possibly because the `atom-languageclient` README just advised its users to copy [this list of consumed/provided services](https://github.com/atom/ide-csharp/blob/master/package.json) that does not include `nuclide-refactor`.

I normally wouldn’t rename a service that was already in the wild under another name, but I figure it’s worth it just to purge the negative [Nuclide](https://nuclide.io/) energy and give us a fresh start.

This was not a hard package to write. We could’ve had this functionality all along!

### Providing the `refactor` service

Version `0.1.0` of `refactor` implements the service contract described by the mainline `atom-languageclient`. If your IDE backend package wraps `atom-languageclient`, it is highly likely that you can add the following block **in the `providedServices` section of your `package.json`** and get refactor support for free:

```json
"refactor": {
  "versions": {
    "0.1.0": "provideRefactor"
  }
}
```

Your package’s language service would still need to support rename requests, but `atom-languageclient` will ask first and do the right thing if it doesn’t.

At some point since this service was first described, the LSP specification added the concept of a `prepareRename` action: when invoked at a given buffer position, the server can return the range of a rename-able symbol that contains that position.

Since this wasn’t implemented by `atom-languageclient`, I took the liberty of adding this as an optional part of the `refactor` service contract and bumping the version number to `0.2.0`. You can enable your package to provide this enhanced version of `refactor` by switching to the [`@savetheclocktower/atom-languageclient` fork](https://www.npmjs.com/package/@savetheclocktower/atom-languageclient) and using this snippet instead of the one above:

```json
"refactor": {
  "versions": {
    "0.1.0": "provideRefactor",
    "0.2.0": "provideRefactorWithPrepare"
  }
}
```
