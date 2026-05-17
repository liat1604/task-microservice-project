#!/usr/bin/env bash
set -euo pipefail

: "${AZURE_SUBSCRIPTION_ID:?Environment variable AZURE_SUBSCRIPTION_ID is required}"
: "${RESOURCE_GROUP:?Environment variable RESOURCE_GROUP is required}"
: "${LOCATION:?Environment variable LOCATION is required}"
: "${ACR_NAME:?Environment variable ACR_NAME is required}"
: "${CONTAINERAPPS_ENV:?Environment variable CONTAINERAPPS_ENV is required}"
: "${FRONTEND_URL:?Environment variable FRONTEND_URL is required}"
: "${JWT_SECRET:?Environment variable JWT_SECRET is required}"
: "${GOOGLE_CLIENT_ID:?Environment variable GOOGLE_CLIENT_ID is required}"
: "${GOOGLE_CLIENT_SECRET:?Environment variable GOOGLE_CLIENT_SECRET is required}"
: "${GOOGLE_CALLBACK_URL:?Environment variable GOOGLE_CALLBACK_URL is required}"

echo "Logging in to Azure..."
az login >/dev/null
az account set --subscription "$AZURE_SUBSCRIPTION_ID"

echo "Creating resource group $RESOURCE_GROUP in $LOCATION..."
az group create --name "$RESOURCE_GROUP" --location "$LOCATION"

echo "Creating Azure Container Registry $ACR_NAME..."
az acr create --resource-group "$RESOURCE_GROUP" --name "$ACR_NAME" --sku Standard --admin-enabled true
ACR_LOGIN_SERVER=$(az acr show --name "$ACR_NAME" --resource-group "$RESOURCE_GROUP" --query loginServer -o tsv)

echo "Building and pushing task-service..."
az acr build --registry "$ACR_NAME" --image task-service:latest ./service

echo "Building and pushing api-gateway..."
az acr build --registry "$ACR_NAME" --image api-gateway:latest ./gateway

echo "Building and pushing frontend..."
az acr build --registry "$ACR_NAME" --image frontend:latest ./frontend

echo "Creating Container Apps environment $CONTAINERAPPS_ENV..."
az containerapp env create --name "$CONTAINERAPPS_ENV" --resource-group "$RESOURCE_GROUP" --location "$LOCATION"

echo "Deploying MongoDB container app..."
az containerapp create --name mongodb --resource-group "$RESOURCE_GROUP" --environment "$CONTAINERAPPS_ENV" \
  --image mongo:7 --target-port 27017 --ingress internal

echo "Deploying Redis container app..."
az containerapp create --name redis --resource-group "$RESOURCE_GROUP" --environment "$CONTAINERAPPS_ENV" \
  --image redis:7-alpine --target-port 6379 --ingress internal

echo "Deploying task service container app..."
az containerapp create --name task-service --resource-group "$RESOURCE_GROUP" --environment "$CONTAINERAPPS_ENV" \
  --image "$ACR_LOGIN_SERVER/task-service:latest" --target-port 3001 --ingress internal \
  --env-vars REDIS_URL="redis://redis:6379" MONGO_URL="mongodb://mongodb:27017/taskdb" JWT_SECRET="$JWT_SECRET" FRONTEND_URL="$FRONTEND_URL" GOOGLE_CLIENT_ID="$GOOGLE_CLIENT_ID" GOOGLE_CLIENT_SECRET="$GOOGLE_CLIENT_SECRET" GOOGLE_CALLBACK_URL="$GOOGLE_CALLBACK_URL"

echo "Deploying API gateway container app..."
az containerapp create --name api-gateway --resource-group "$RESOURCE_GROUP" --environment "$CONTAINERAPPS_ENV" \
  --image "$ACR_LOGIN_SERVER/api-gateway:latest" --target-port 3000 --ingress external \
  --env-vars JWT_SECRET="$JWT_SECRET"

echo "Deploying frontend container app..."
az containerapp create --name frontend --resource-group "$RESOURCE_GROUP" --environment "$CONTAINERAPPS_ENV" \
  --image "$ACR_LOGIN_SERVER/frontend:latest" --target-port 3000 --ingress external

echo "Cloud deployment complete."
echo "Gateway URL: $(az containerapp show --name api-gateway --resource-group "$RESOURCE_GROUP" --query properties.configuration.ingress.fqdn -o tsv)"
