bugzilla.js
===========

Bugzilla.js is a quick prototype for an AJAX-y bugzilla frontent.

You can go the github pags of this project to see this in action: http://andreasgal.github.io/bugzilla.js/

What this does
==============

This is an AJAX frontend. When you load it for the first time it will fetch the bugzilla configuration (which is slow and takes forever). This will be fetched from local storage (indexeddb) for all future instances of loading the page (its also updated in parallel at every page load, there is no way to query with the current bugzilla REST API the time it last changed).

After we have the configuration (from local cache or bugzilla), a bug is loaded. Bugs are always cached locally, including all bugs they refer to, and all comments. This should make navigation of bug forests near-instant, in particular because developers tend to operate on the same small-ish set of bugs, which quickly will be all in the local cache.

Every time a bug is opened, we first fetch the bug details and immediately display that. We then fetch dependend bugs (since we need to format them with a strikethrough in case the status is RESOLVED) and the page is updated as the page loads. Comments are fetched last. All these fetches happen concurrently. In this context fetch means always that we first load the version from the local cache, and then query the service in the background whether the bug was updated, and then load the update and display the new date (and cache it).

Voila: and instant bugzilla experience. This is a very limited demo. The current bugzilla REST API is not suitable for what I am using it for. Very small changes to the protocol would dramatically improve performance. This is only meant as a demonstration of an approach, nothing more.
