# EECS Print Lab

Student print-request interface for EECS 373/473.

- Intended site: **https://eecs373.github.io/**
- Repository: **EECS373/eecs373.github.io**
- Backend API: `https://jamescarl.net/prints/api/`
- Staff page: `https://jamescarl.net/prints/#staff`

This repository contains only the static student frontend. Student files, records, staff authentication, queue management, ZIP downloads and Telegram delivery run on Unraid. No database credentials, passwords, model files or notification tokens belong in this repository.

## Publishing

In repository Settings → Pages, choose **Deploy from a branch**, **main**, **/ (root)**. The `.nojekyll` file disables Jekyll processing. GitHub then updates the site when changes are pushed to the publishing branch. Do not configure a custom domain.

## Configuration

`site-config.js` contains public deployment URLs. Keep `studentOnly: true`. It must contain no credentials or API secrets. Staff administration is linked to the backend and is not hosted by this site.

The backend must allow the exact student origin `https://eecs373.github.io` for its public endpoints. Student requests omit cookies; staff sessions remain on the Unraid origin. If Unraid is unavailable, the interface displays an offline/error state rather than accepting a submission that was not saved.

The seven runtime files are generated from the maintained portal source using its `scripts/build-pages.mjs` helper. Staff HTML and staff JavaScript are removed during this build.
