# Security notes

Never commit provider credentials. Use `artifacts/api-server/.env` locally and keep it ignored. The repository includes `.env.example` only.

If a credential was ever committed, rotate/revoke it at the provider and rewrite the Git history before publishing the repository. Removing the current file does not erase older commits.

The public API server should not be exposed directly to the internet without authentication, rate limiting, and an appropriate origin policy.
