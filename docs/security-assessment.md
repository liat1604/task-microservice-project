# Security Assessment — Task Microservice

## Scenario

**Description**

A task-management microservice that lets users register, log in, and create/manage personal tasks through a React frontend, an API Gateway, and a task service backed by MongoDB and Redis.

**Why data must be kept secure**

- Privacy: Task contents and user metadata can reveal sensitive personal or business information.
- Trust: Users must trust the service with credentials and private data — breaches destroy reputation.
- Compliance: Laws/regulations (GDPR, CCPA) can apply to stored PII and require secure handling.
- Abuse prevention: Compromised accounts enable spam, fraud, lateral attacks, and data exfiltration.

---

## 3.2 Security analysis (frontend and backend)

- **Transport security**: HTTPS enforced between clients and gateway; internal services use TLS where possible. Protects credentials and tokens in transit.
- **Authentication**: Backend issues short-lived JWT access tokens (signed with a strong secret) and refresh tokens where applicable; tokens sent in `Authorization: Bearer` headers. Stateless JWTs scale well but require short TTLs and revocation strategies.
- **Password storage**: Passwords hashed with `bcrypt` (work factor >= 10) and never stored in plaintext. Resists offline cracking if DB leaked.
- **Input validation & sanitization**: `express-validator` used on inputs to prevent NoSQL injection and XSS.
- **Rate limiting & brute-force protection**: `express-rate-limit` applied on auth endpoints to mitigate credential stuffing and automated guessing.
- **Access control**: Role-based checks (`authorize(['USER','ADMIN'])`) and principle of least privilege for service accounts.
- **Secrets management**: Secrets loaded from env vars (`.env`) and stored in cloud secret stores for CI/CD; never committed to source control.
- **Logging & monitoring**: Winston logs and Prometheus metrics; sensitive fields are redacted. Enables detection and incident response.
- **Caching & session invalidation**: Redis used with cache-aside; token revocation supported via short TTLs and optional revocation lists.
- **Dependency hygiene**: `npm audit`, pinned versions, and CI checks reduce exposure from known CVEs.
- **Secure headers**: Enforce `CSP`, `X-Content-Type-Options`, `Strict-Transport-Security` at gateway.

**Effectiveness**: The layered (defense-in-depth) approach reduces attack surface, but effectiveness depends on correct configuration, secret strength, TLS for all endpoints, and ongoing maintenance.

---

## 3.3 Authentication and authorization methods

### Common methods (brief)

- Passwords (local): simple, but relies on good password hygiene.
- Multi-Factor Authentication (MFA): adds OTP or device factor; recommended for high-risk actions.
- OAuth2 / OpenID Connect (delegated): Google social login used to offload credential handling.
- SAML / Enterprise SSO: for corporate users.
- API keys / mutual TLS: for service-to-service authentication.
- JWTs vs sessions: JWTs are stateless and performant; sessions are stateful and easier to revoke.

### Project choice & justification

- Primary: Local username/password with `bcrypt` hashing, plus optional Google OAuth (OIDC) for social login. This supports users who want local accounts while offering OAuth convenience and reduced credential handling.
- Token type: Short-lived JWT access tokens with refresh tokens stored securely (httpOnly cookies or server-side store). JWTs enable gateway-based authorization and horizontal scaling; short TTLs limit attack windows.
- Authorization: Role-Based Access Control (RBAC) via middleware enforces least privilege (e.g., `USER`, `ADMIN`). Simple and sufficient for this project.
- Recommended extra measures: Enforce MFA for sensitive operations, device/session management for listing/revocation, and provider-managed identity for cloud resources.

### References

- OWASP Authentication Cheat Sheet: https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html
- NIST SP 800-63B: https://pages.nist.gov/800-63-3/sp800-63b.html
- OAuth 2.0 / OIDC: https://openid.net/specs/

---

## 3.4 Real-world security failures and analysis

### Case 1 — OAuth misconfiguration / token leakage

- **Issue**: Improper redirect URI validation or leaking tokens via URL allowed token capture.
- **Impact**: Account takeover.
- **Prevention**: Exact redirect URI matching, use `state`, PKCE for public clients, deliver tokens via secure channels.
- **Ref**: RFC 6819 (OAuth 2.0 security considerations): https://datatracker.ietf.org/doc/html/rfc6819

### Case 2 — Broken authentication & poor password handling

- **Issue**: Weak password policies and no rate limiting enabled credential stuffing.
- **Impact**: Large-scale account takeover.
- **Prevention**: Enforce strong passwords, ban common passwords, rate-limit logins, require MFA.
- **Ref**: OWASP Top 10 — Broken Authentication: https://owasp.org/www-project-top-ten/

### Case 3 — Long-lived tokens & no revocation

- **Issue**: Long-lived bearer tokens leaked without revocation.
- **Impact**: Persistent unauthorized access.
- **Prevention**: Short-lived access tokens, secure refresh token handling, revocation lists (Redis), re-authentication for sensitive ops.
- **Ref**: JWT best practices: https://auth0.com/learn/what-is-jwt/

### Case 4 — Misconfigured access control / excessive privileges

- **Issue**: Client-supplied role flags or missing server-side checks allowed privilege escalation.
- **Impact**: Data leakage and unauthorized admin operations.
- **Prevention**: Server-side RBAC/ABAC, never trust client-provided roles, validate token claims against the user store.
- **Ref**: OWASP Access Control Cheat Sheet: https://cheatsheetseries.owasp.org/cheatsheets/Access_Control_Cheat_Sheet.html

### Case 5 — Secrets in source control

- **Issue**: Committing credentials to public repos; attackers scan for secrets.
- **Impact**: Compromise of downstream systems.
- **Prevention**: Use env vars, secret managers (Vault, cloud secret stores), rotate keys, secret scanning on PRs.

---

## Summary

Preventing auth/authorization failures requires secure design, correct configuration, operational hygiene (monitoring, rotation), and developer guardrails (scanning, CI checks). This project implements a layered approach but must maintain operational discipline to remain secure.

---

## Appendix — Conversion

The file can be converted locally to PDF with `pandoc`:

```bash
pandoc docs/security-assessment.md -o docs/security-assessment.pdf
```

Or on Windows with PowerShell and WSL/pandoc installed. If `pandoc` is not available, install it from https://pandoc.org/installing.html
