#!/usr/bin/env node
// Inputs come from environment variables (set by .github/workflows/deploy.yml from repo secrets/variables).
import * as path from 'node:path'
import { App } from 'aws-cdk-lib'
import { CounterDropStack } from '../lib/counter-drop-stack.ts'

const env = (k: string, fallback = '') => (process.env[k] ?? '').trim() || fallback
const root = path.resolve(import.meta.dirname, '../../..')
const app = new App()

new CounterDropStack(app, env('CD_STACK_NAME', 'CounterDrop'), {
  // Region from AWS_REGION, not CDK_DEFAULT_REGION: the CLI defaults that to us-east-1.
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: env('AWS_REGION', 'ap-south-1') },
  description: 'Counter Drop MVP: CloudFront + S3 + API Gateway + Lambda + DynamoDB',
  lambdaDir: env('CD_LAMBDA_DIR', path.join(root, 'build/lambda')),
  webDir: env('CD_WEB_DIST', path.join(root, 'web/dist')),
  realtimeKey: env('CD_REALTIME_KEY'),
  originSecret: env('CD_ORIGIN_SECRET'),
  // With a custom domain the URL is known up front. Without one, the workflow passes the CloudFront
  // URL from the previous deploy (first deploy: empty, then a second pass fills it in).
  publicUrl: env('DOMAIN_NAME') ? `https://${env('DOMAIN_NAME')}` : env('CD_PUBLIC_URL') || undefined,
  domainName: env('DOMAIN_NAME') || undefined,
  certificateArn: env('CERTIFICATE_ARN') || undefined,
  hostedZoneId: env('HOSTED_ZONE_ID') || undefined,
  hostedZoneName: env('HOSTED_ZONE_NAME') || undefined,
  extraOrigins: env('CD_EXTRA_ORIGINS').split(',').map((o) => o.trim()).filter(Boolean),
  alarmEmail: env('ALARM_EMAIL') || undefined,
  monthlyBudgetUsd: Number(env('MONTHLY_BUDGET_USD', '10')),
  tableName: env('CD_DYNAMODB_TABLE', 'cd-main'),
  connectionsTableName: env('CD_WS_CONNECTIONS_TABLE', 'cd-connections'),
  tags: { app: 'counter-drop', env: 'prod' },
})
