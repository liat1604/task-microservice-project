<<<<<<< HEAD
# task-microservice-project
=======
# Task Manager Microservice Project

## Project Overview

A secure microservices-based Task Management application built with Node.js, Express, MongoDB, Redis, and Docker.

## Features Implemented

### Core Requirements

- **Basic Microservice** - Task CRUD operations
- **API Gateway**- All traffic routed through gateway
- **JWT Authentication** - Secure login/register
- **Role-Based Authorization** - ADMIN / USER roles
- **Input Validation & Rate Limiting** - express-validator + rate-limit
- **Frontend** - React with full CRUD
- **Security Patterns** - API Gateway, RBAC, Cache-Aside, etc.

### Additional / Bonus Features

- Docker + Docker Compose
- MongoDB (persistent storage)
- Redis Caching Layer
- Winston Structured Logging
- Prometheus Metrics (`/metrics` endpoint)
- Health Check Endpoints
- User Registration
- Google OAuth login support (`/auth/oauth/google`)
- Azure Container Apps deployment helper

## Tech Stack

- Backend: Node.js + Express
- Database: MongoDB
- Cache: Redis
- Frontend: React
- Containerization: Docker & Docker Compose
- Monitoring: Prometheus + Winston

## How to Run

```bash
# 1. Clone or navigate to project folder
docker compose down
docker compose up --build
```

## Cloud deployment

The repository includes an Azure Container Apps deployment helper.

1. Copy `.env.example` to `.env` and fill in the Google OAuth and cloud values.
2. See `deploy/README.md` for Azure setup and deployment commands.
3. Run:

```bash
cd deploy
bash azure-containerapps.sh
```
>>>>>>> fd0d0fa (Initial project import with auth gateway, service, frontend, and deployment helpers)
