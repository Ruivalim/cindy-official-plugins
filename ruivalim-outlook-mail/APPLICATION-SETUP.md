# Microsoft application registration and release setup

2.0.0 uses Cindy Host-managed OAuth + PKCE only. The publisher or enterprise IT configures a public application Client ID once, and ordinary users then sign in and authorize; no client secret is needed. 2.0.1 bundles the global public Client ID provided by the administrator on 2026-09-09, so global users do not need to enter an application ID. Having an application available does not mean real authorization has been verified.

The administrator should check that the global application supports both organizational and personal Microsoft accounts, has the public desktop redirect `http://127.0.0.1:53687/callback`, and has the delegated user permissions listed below. If sign-in reports an application or redirect error, fix the Microsoft application registration instead of switching to a client secret.

## Registration

| Item | Global |
| --- | --- |
| Registration portal | https://portal.azure.com |
| Target accounts | Any organizational directory + personal Microsoft accounts |
| Authorization host | login.microsoftonline.com |
| Graph host | graph.microsoft.com |
| Desktop redirect URI | http://127.0.0.1:53687/callback |
| Plugin credential key | outlook_global |

1. In Microsoft Entra ID → App registrations, create a new application, for example "Cindy Outlook Mail". It must support both personal and organizational accounts.
2. Configure it as a **mobile and desktop application / public client** and register the exact redirect URI from the table. Do not register it as a Web app or SPA that requires a client secret.
3. The regular portal input may reject `http://127.0.0.1`. Configure the public client redirect through the application manifest editor the portal currently supports (`publicClient.redirectUris` in Microsoft Graph format, or `replyUrlsWithType` + `InstalledClient` in the legacy manifest). Do not replace it with `localhost`: Cindy always listens on and sends the `127.0.0.1` callback.
4. Add the Microsoft Graph **delegated permissions** `User.Read`, `Mail.ReadWrite` and `Mail.Send`. The plugin also requests `openid` and `offline_access` for sign-in and long-lived refresh. Do not request Application permissions or tenant-wide mail access.
5. A public desktop application needs no client secret. Copy the "Application (client) ID" and enter it in the setup form. When an application is already configured, change it under "More settings → Connection application". If administrator consent is required, a tenant administrator grants it; some organizations may also require publisher verification or an explicit allow for this application.
6. Sign in with an authorized test account and test reading and searching, saving drafts, changing read state and moving test messages. Only test sending after getting permission for the test recipients and content.
7. Verify at least one personal Outlook account and one organizational Microsoft 365 account. Verify that reauthorizing the same account does not add it twice, and that real token expiry and refresh work.

## Bundled public Client ID

For the final release, write the UUID to `network.secrets[].oauth.clientId` in `ghost.json`. Bundle only the **Client ID**; never write passwords, client secrets, access tokens or refresh tokens.

After changing it, bump the plugin version, repackage, install the final package in a release build of Cindy, and verify real authorization and mail operations.

## Official references

- Cloud deployments and endpoints: https://learn.microsoft.com/en-us/graph/deployments
- Desktop app registration: https://learn.microsoft.com/en-us/entra/identity-platform/scenario-desktop-app-configuration
- Redirect URI restrictions and 127.0.0.1: https://learn.microsoft.com/en-us/entra/identity-platform/reply-url
- Graph list messages: https://learn.microsoft.com/en-us/graph/api/user-list-messages?view=graph-rest-1.0
- Send acceptance status: https://learn.microsoft.com/en-us/graph/api/user-sendmail?view=graph-rest-1.0
