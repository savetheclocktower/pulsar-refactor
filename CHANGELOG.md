# Planned — ?

* Define a new service version that includes:
  * Ability for a provider to include error details instead of an opaque `null` response
  * Metadata about providers so that this package can list its providers in a way that is meaningful to the user
  * Ability for a provider to describe file-based edits — file creation, file renaming, file deletion — in addition to text-based edits
  * Ability for the `prepareRename` method to return other metadata, like `placeholder`, instead of just a `Range`


# 0.0.4 — 2022-06-22

* Favor an “enhanced” provider with `prepareRename` support over one without, all else being equal.
* Improve handling of how we cascade through multiple providers. Previously, we picked the highest-ranked provider and pledged ourselves to it no matter what. Now, if our chosen provider returns `null`, we’ll move to the next provider (if one is present), continuing until we find a provider that will return a result for the given request.

    You probably won’t notice this, but it’s a workaround for the theoretical fact that an `atom-languageclient` wrapper may _claim_ to support refactoring (if its author copied some boilerplate metadata) but won’t _actually_ support refactoring. In such cases, we don’t want a nonfunctioning provider to get in the way of another provider that works.
