# React + Vite

This template provides a minimal setup to get React working in Vite with HMR and some ESLint rules.

Currently, two official plugins are available:

- [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react) uses [Oxc](https://oxc.rs)
- [@vitejs/plugin-react-swc](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react-swc) uses [SWC](https://swc.rs/)

## React Compiler

The React Compiler is not enabled on this template because of its impact on dev & build performances. To add it, see [this documentation](https://react.dev/learn/react-compiler/installation).

## Automatic deployment

The GitHub Actions workflow in `.github/workflows/deploy.yml` deploys the app to Cloudflare Workers whenever changes are pushed to `main`. It installs dependencies with `npm ci`, builds the app, and runs the project's locally installed Wrangler version.

Before the first deployment, add these repository secrets under **Settings > Secrets and variables > Actions**:

- `CLOUDFLARE_API_TOKEN`: a Cloudflare API token authorized to deploy Workers for this account.
- `CLOUDFLARE_ACCOUNT_ID`: the Cloudflare account ID that owns the Worker.

You can also start a deployment manually from the repository's **Actions** tab using **Deploy to Cloudflare Workers > Run workflow**.

## Expanding the ESLint configuration

If you are developing a production application, we recommend using TypeScript with type-aware lint rules enabled. Check out the [TS template](https://github.com/vitejs/vite/tree/main/packages/create-vite/template-react-ts) for information on how to integrate TypeScript and [`typescript-eslint`](https://typescript-eslint.io) in your project.
