# Counter Drop on AWS (CDK)

One CloudFormation stack, `CounterDrop`, in `ap-south-1` (Mumbai). AWS services only.

```
phone/PC ─HTTPS─► CloudFront ─┬─ /*      ► S3 "Web" bucket (PWA; private, Origin Access Control)
                              └─ /api/*  ► API Gateway HTTP API ► Lambda api ─► DynamoDB cd-main
phone/PC ─presigned PUT/GET──────────────► S3 "Files" bucket (file bytes never pass through Lambda)
phone/PC ─wss──► API Gateway WebSocket ► Lambda ws ─► DynamoDB cd-connections
DynamoDB cd-main stream ► Lambda push ─► WebSocket @connections   (live board / ticket updates)
EventBridge rule, every minute ► Lambda sweeper ─► DynamoDB + S3 deletes (privacy promise)
CloudWatch alarms ► SNS ► email          AWS Budgets ► email
```

Deploys run from GitHub Actions (`.github/workflows/deploy.yml`); nothing needs installing on your Mac.

## One-time setup

### 1. AWS account
- Sign in as the root user once: turn on MFA, then create an IAM user for yourself with console access (and MFA). Stop using root.
- Billing → Billing preferences → turn on "Receive Free Tier usage alerts".

### 2. Deploy user for GitHub
IAM → Users → Create user `counter-drop-deployer` (no console access) → attach **AdministratorAccess** for the first deploy (CDK bootstrap creates IAM roles) → Security credentials → Create access key ("Application running outside AWS").

After the first successful deploy, replace AdministratorAccess with this inline policy — CDK then deploys through the roles bootstrap created, and the Admin workflow can still reach the table:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    { "Effect": "Allow", "Action": "sts:AssumeRole", "Resource": "arn:aws:iam::*:role/cdk-*" },
    { "Effect": "Allow", "Action": ["cloudformation:DescribeStacks", "sts:GetCallerIdentity"], "Resource": "*" },
    { "Effect": "Allow", "Action": ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem",
        "dynamodb:Query", "dynamodb:TransactWriteItems", "dynamodb:ConditionCheckItem", "dynamodb:DescribeTable"],
      "Resource": ["arn:aws:dynamodb:ap-south-1:*:table/cd-main", "arn:aws:dynamodb:ap-south-1:*:table/cd-main/index/*"] }
  ]
}
```

The workflow only runs `cdk bootstrap` when the `CDKToolkit` stack is missing. If you ever need to re-bootstrap (e.g. a CDK upgrade asks for it), re-attach AdministratorAccess for that one run.

### 3. GitHub repo settings → Secrets and variables → Actions
| Kind | Name | Value |
|---|---|---|
| Secret | `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | from step 2 |
| Secret | `CD_REALTIME_KEY` | `openssl rand -hex 32` — signs 60-second live-update tickets |
| Secret | `CD_ORIGIN_SECRET` | `openssl rand -hex 32` — CloudFront adds it; the API refuses requests without it |
| Variable | `AWS_REGION` | `ap-south-1` |
| Variable | `ALARM_EMAIL` | where alarms and budget alerts go (confirm the SNS email after the first deploy) |
| Variable | `MONTHLY_BUDGET_USD` | `10` |
| Variable | `VITE_OPERATOR_NAME`, `VITE_SUPPORT_EMAIL` | shown on the privacy/terms pages |
| Variable | `DOMAIN_NAME`, `CERTIFICATE_ARN`, `HOSTED_ZONE_ID` | leave empty for the first deploy (step 5) |

Keep the repository **private**: the Admin workflow prints one-time setup links in its log.

### 4. Deploy
Actions → **Deploy to AWS** → Run workflow. The first run takes ~15 minutes (CloudFront). It deploys twice on the first run to learn the CloudFront address, then smoke-tests:
the site loads, a deep link loads, the API answers through CloudFront, and the API refuses requests that skip CloudFront.

Then Actions → **Admin** → `create-shop` (slug, shop name, owner, address). Open the printed setup link on the owner's phone to set a PIN.

### 5. Custom domain `counterdrop.cloudsuggest.in` (when ready)
`cloudsuggest.in` is a Route 53 hosted zone shared by several apps (e.g. `housing.cloudsuggest.in`). Each app's stack
creates only its own A/AAAA alias records; the zone and the certificate are shared.

1. AWS console, region **N. Virginia (us-east-1)** → Certificate Manager → Request public certificate with
   `*.cloudsuggest.in` and `cloudsuggest.in`, DNS validation → **Create records in Route 53**. Wait for "Issued".
   One certificate serves every app on the domain (one level deep: `x.cloudsuggest.in`, not `a.x.cloudsuggest.in`).
2. Route 53 → Hosted zones → `cloudsuggest.in` → copy the **Hosted zone ID** (`Z…`).
3. Set repo variables and run Deploy:
   - `DOMAIN_NAME=counterdrop.cloudsuggest.in`
   - `CERTIFICATE_ARN=<the ARN>`
   - `HOSTED_ZONE_ID=<the zone ID>`
   The stack adds the domain to CloudFront and creates `counterdrop` A + AAAA alias records. A record of the same
   name made by hand is replaced (`deleteExisting`), so no console edits are needed. Leave `HOSTED_ZONE_ID` empty to
   manage DNS yourself: then add `CNAME counterdrop → <CloudFrontUrl output>` at your DNS host.
4. Check: `dig +short counterdrop.cloudsuggest.in` shows CloudFront addresses and `https://counterdrop.cloudsuggest.in` loads.

Set `HOSTED_ZONE_NAME` only when the zone is not the domain minus its first label (e.g. domain
`app.shop.example.com` in zone `example.com`).

Another app on the same domain: reuse `CERTIFICATE_ARN` and `HOSTED_ZONE_ID`, but give it its own stack name, table
names and `DOMAIN_NAME`. Two CloudFront distributions cannot claim the same name.

Setup links and QR codes use the site URL, so make this switch **before printing QR codes** for shops.
Live updates stay on the API Gateway `execute-api` address (no second certificate needed).

### 6. Check by hand after the first deploy
- Confirm the SNS subscription email (alarms) — AWS sends it to `ALARM_EMAIL`.
- Sign in on the shop board once, then in CloudWatch Logs (`/aws/lambda/CounterDrop-Api…`) check the request log shows a **viewer** IP, not a CloudFront edge address. That proves `CloudFront-Viewer-Address` reaches the API (otherwise everyone behind one edge shares the sign-in limit).
- Send a test job from a phone: upload, the board updates live, download, mark collected; after pickup the file disappears from the Files bucket within a few minutes.
- Service Quotas → AWS Lambda → "Concurrent executions": brand-new accounts may be at 10. Request 1,000 (free, usually automatic) before launch.

### If the very first deploy fails
CloudFormation rolls back and removes everything, including the table, so just fix the cause and re-run. A common first-time cause: CloudFront refuses new accounts until AWS verifies them — open a support case ("Account verification for CloudFront") and re-run when it is done.
If a later run ever says `cd-main already exists` with no stack present, delete the leftover table: `aws dynamodb update-table --table-name cd-main --no-deletion-protection-enabled` then `aws dynamodb delete-table --table-name cd-main` (only when it holds nothing you need).

## Local checks
```
cd deploy/cdk && npm ci && npm test      # template assertions
CD_REALTIME_KEY=$(openssl rand -hex 32) CD_ORIGIN_SECRET=$(openssl rand -hex 32) npx cdk synth
```
`cdk synth` needs `build/lambda/bootstrap` and `web/dist` (see the workflow's build steps).

## Things to know
- Tables `cd-main` (deletion protection + 7-day point-in-time recovery) and the Files bucket are **retained** if the stack is deleted.
- The two secrets are in plain text in the Lambda environment, the CloudFront origin settings and the CloudFormation template (also in the CDK assets bucket). Anyone with read access to this AWS account can see them. Fine for a one-person MVP account; move them to SSM Parameter Store SecureString before others get console access.
- Rolling back: re-run Deploy on an older commit.
