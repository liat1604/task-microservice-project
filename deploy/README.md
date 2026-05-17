# Azure Cloud Deployment

This repository includes a deployment helper for Azure Container Apps.

## Prerequisites

- Azure CLI installed
- Logged in with `az login`
- Subscription selected
- `az extension add --name containerapp --upgrade`

## Required environment variables

Create an environment file or export these values before running the script:

```bash
export AZURE_SUBSCRIPTION_ID="<your-subscription-id>"
export RESOURCE_GROUP="task-microservice-rg"
export LOCATION="eastus"
export ACR_NAME="<youracrname>"
export CONTAINERAPPS_ENV="taskapps-env"
export FRONTEND_URL="https://<your-frontend-url>"
export JWT_SECRET="supersecretkey_change_this_in_production_2026"
export GOOGLE_CLIENT_ID="<your-google-client-id>"
export GOOGLE_CLIENT_SECRET="<your-google-client-secret>"
export GOOGLE_CALLBACK_URL="https://<your-gateway-host>/api/auth/oauth/google/callback"
```

## Deploy

```bash
cd deploy
bash azure-containerapps.sh
```

## Notes

- The script builds the `service`, `gateway`, and `frontend` containers and pushes them to Azure Container Registry.
- It deploys MongoDB and Redis as internal Azure Container Apps services.
- The gateway is exposed publicly and proxies requests to the internal task service.
- OAuth login is supported via Google and will redirect back to the frontend.
