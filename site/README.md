# Production download cards

`app-downloads.js` is the production website controller, mirrored from the site
checkout. Its fixed URL reads the manifest written by the restricted GitLab
publisher. The site HTML includes four `data-release-platform` cards and exact
static links as an offline/no-JavaScript fallback. Normal app releases update
the manifest, files and per-platform notes automatically; no HTML deployment
or GitHub availability is required for those releases.

The live site loads `/app-downloads.js?v=0.2.5`. Controller changes themselves
are website-code changes, not application installers, and require site checks
and deployment. The current full website source remains in the website checkout.
