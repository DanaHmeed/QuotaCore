# Usage Metering and Quota Service 
## (First Draft)

A backend service built with TypeScript and PostgreSQL to track resource consumption and enforce account-level and user-level usage quotas.

## Tech Stack

- Node.js
- TypeScript
- Express.js
- PostgreSQL
- Docker
- Git and GitHub

## Core Features

- Account management and API key authentication
- User registration and plan assignment
- Predefined and custom plans
- Monthly allowances and per-request limits
- Atomic usage consumption
- Idempotent request handling
- Usage reporting and history
- Automated and performance testing

## Project Status

**Stage 1 — Initial project setup**

## Getting Started

Development setup instructions will be added as the project is implemented.

## Account Management

### Create Account

POST /accounts

Requires X-Admin-Key header.

Request:
{
  "name": "CloudDocs",
  "planName": "Starter"
}

Creates an account, assigns a predefined account plan,
and returns an API key.

### Get Authenticated Account

GET /accounts/me

Requires X-API-Key header.

Returns the authenticated account's information.

### Security

- API keys are generated using cryptographic randomness.
- Only SHA-256 hashes of account API keys are stored.
- Account API keys are returned only at creation.
- Account creation is protected by a bootstrap admin key.
- Bootstrap key management requires additional hardening
  before production deployment.