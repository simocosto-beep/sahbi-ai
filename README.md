# Sahbi AI

Chat-first AI assistant.

## Current live mode

The GitHub Pages frontend currently uses Puter cloud mode until the Sahbi server-side API is deployed.

## Vercel server-side AI endpoint

This repository now includes `api/chat.js`, designed for Vercel Functions and Vercel AI Gateway.

Why this architecture:
- no local model download for visitors;
- no end-user Puter login;
- no provider API key exposed in browser code;
- Vercel deployments can authenticate to AI Gateway with server-side OIDC;
- the browser only talks to Sahbi's own `/api/chat` endpoint.

After importing this repository into a Vercel project and confirming AI Gateway/OIDC is available, the frontend can be switched from Puter to `/api/chat`.
