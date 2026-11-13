# Registering the GitHub App

The App "C8Y UI Agent" gives the agent its bot identity and the short-lived tokens of the apply job (D2, D7, D9). An owner of the `Cumulocity-IoT` organization registers it once. Not done yet.

## Register

Organization settings → Developer settings → GitHub Apps → New GitHub App:

| Setting | Value |
|---|---|
| GitHub App name | `C8Y UI Agent` (slug and handle `c8y-ui-agent`, bot login `c8y-ui-agent[bot]`) |
| Homepage URL | `https://github.com/Cumulocity-IoT/c8y-ui-agent` |
| Callback URL, user authorization during installation, device flow | None, off |
| Webhook | Off ("Active" cleared): workflows start runs, not webhooks |
| Where can this GitHub App be installed? | Only on this account |

Repository permissions; everything else stays "No access":

| Permission | Access | Used by |
|---|---|---|
| Contents | Read and write | Apply job: push `agent/*` branches |
| Issues | Read and write | Apply job: status comment, `agent:*` labels |
| Pull requests | Read and write | Apply job: open and update pull requests, comment |
| Metadata | Read-only | Required by GitHub |

No Workflows permission: GitHub then rejects any push from the App that changes `.github/workflows`, whatever the apply job's checks say. No organization or account permissions, no event subscriptions.

The apply job asks for less than the App has: `actions/create-github-app-token` with `permission-*` inputs (see [result.md](result.md#the-apply-job) and `run.yml`), and gets write access to contents only after its check passed. The context job reads the issue thread with the run's job token, not the App's (D19).

## After registering

1. **Private key:** generate one on the App's page. Store it as the organization secret `C8Y_UI_AGENT_APP_KEY`, and the App's Client ID as `C8Y_UI_AGENT_CLIENT_ID`. Repository access: selected repositories, the ones that install the App. Delete the downloaded key file.
2. **Install** the App on the organization with "Only select repositories", starting with `cumulocity-ui-toolkit`. Add repositories as they onboard.
3. **Handle:** register the user account `c8y-ui-agent` as a placeholder machine account owned by the organization, so that nobody else can take the handle and receive the mentions (D9).
4. **Package access:** in the settings of each internal package the agent installs (`@cumulocity-iot/c8y-ui-apply`, `@cumulocity-iot/c8y-ui-workbench`, `@cumulocity-iot/ui-sdk`, `@cumulocity-iot/c8y-web-sdk-knowledge-mcp`), add the repository under Manage Actions access.

Rotate the private key by generating a new one, updating the secret, and deleting the old key on the App's page.
