# Fresh client installation overview

Treat this as a fresh client installation: reuse the application code, but create new resources, credentials, and business data.

Linux is the setup computer; the application runs on Cloudflare. An Apple device is still used to manage the iCloud shared album.

## Setup order

1. **Choose the application version and clone the repository.** Confirm which release includes the required fixes. Install Git, a compatible Node.js version, and the project dependencies on Linux.

2. **Prepare client-owned accounts.** Cloudflare, Google, Airtable, LINE Official Account/Messaging API, an Apple account for the shared album, and Anthropic API access for captions are required. Keep credentials in a password manager.

3. **Create the Airtable base.** Create empty `Products` and `Publication Runs` tables with the required fields, types, formulas, and links. Create a Personal Access Token restricted to this base.

4. **Set up Google Drive and Docs.** Create the output folder and document template. Create a Google Cloud project, enable Drive/Docs/Picker APIs, configure OAuth, and authorize the client's Google account to obtain a refresh token. See [Google OAuth setup](google-oauth-setup.md) and [publication setup](publication-setup.md).

5. **Set up the LINE bot.** Create the Official Account and Messaging API channel, obtain its credentials, enable group participation, and add it to the client's admin group. Obtain that group's ID.

6. **Prepare the iCloud shared album.** Enable access through its shared link. Prepare marker cards and a small test product batch. Decide whether any photo-date cutoff is needed. See [album source requirements](album-rotation.md).

7. **Create fresh Cloudflare resources.** Start with staging: create the D1 database, private R2 bucket, Images binding, and four workflow bindings: import, publication, LINE command, and LINE mutation follow-up. Replace the existing project's resource identifiers in deployment configuration. Keep cron jobs disabled during setup.

8. **Configure the application.** Supply the new account credentials and complete `APP_CONFIG_JSON`. Choose the initial product number, folder/table/group IDs, album source, and other settings. Generate separate admin and image-signing secrets. See the [variable reference](../system/configuration-variables.md) and [initial product-ID runbook](product-id-initial-number.md).

9. **Initialize storage and deploy.** Apply all migrations for the chosen release, upload the collage base image, and deploy the staging Worker. Use its new URL in the application configuration. See [deployment](deployment.md).

10. **Initialize product numbering and connect LINE.** Bootstrap the sequence once. Register the new Worker's `/line/webhook` URL in LINE, enable redelivery and error statistics, and verify delivery.

11. **Test the complete flow.** Pass `/health`, authenticated `/setup`, and smoke checks. Then test `/upload`, product search, sale confirmation/cancellation, `/report`, and `/docs` with disposable client test data.

12. **Prepare production and hand over.** Repeat with separate production resources after staging works. Enable only the schedules the client wants, and document account ownership, recovery, credentials, and operating procedures.

## Before starting

The repository contains existing account-specific configuration. At the time this overview was written, some previously deployed changes lived on separate branches. Settle the release baseline and replace the existing account identifiers before deploying from Linux. Do not assume cloning `main` reproduces the existing live deployment.

This is an overview, not an executed installation. No accounts or resources were provisioned for it. Current service pricing and plan requirements must be checked before provisioning.
