import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { App } from 'aws-cdk-lib'
import { Match, Template } from 'aws-cdk-lib/assertions'
import { CounterDropStack, type CounterDropProps } from '../lib/counter-drop-stack.ts'

function synth(over: Partial<CounterDropProps> = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cd-cdk-'))
  const lambdaDir = path.join(tmp, 'lambda'), webDir = path.join(tmp, 'web')
  fs.mkdirSync(lambdaDir); fs.mkdirSync(path.join(webDir, 'assets'), { recursive: true })
  fs.writeFileSync(path.join(lambdaDir, 'bootstrap'), 'x')
  for (const f of ['index.html', 'sw.js', 'manifest.webmanifest', 'assets/app-abc.js']) fs.writeFileSync(path.join(webDir, f), 'x')
  const stack = new CounterDropStack(new App(), 'T', {
    env: { account: '123456789012', region: 'ap-south-1' },
    lambdaDir, webDir, realtimeKey: 'k'.repeat(64), originSecret: 'o'.repeat(64),
    monthlyBudgetUsd: 10, tableName: 'cd-main', connectionsTableName: 'cd-connections', alarmEmail: 'a@example.com', ...over,
  })
  return Template.fromStack(stack)
}

test('main table matches the store (keys, 4 GSIs, stream, TTL, PITR 7 days)', () => {
  const t = synth()
  t.hasResourceProperties('AWS::DynamoDB::Table', {
    TableName: 'cd-main', BillingMode: 'PAY_PER_REQUEST',
    KeySchema: [{ AttributeName: 'PK', KeyType: 'HASH' }, { AttributeName: 'SK', KeyType: 'RANGE' }],
    StreamSpecification: { StreamViewType: 'NEW_AND_OLD_IMAGES' },
    TimeToLiveSpecification: { AttributeName: 'ttl', Enabled: true },
    PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true, RecoveryPeriodInDays: 7 },
    DeletionProtectionEnabled: true,
    GlobalSecondaryIndexes: ['GSI1', 'GSI2', 'GSI3', 'GSI4'].map((ix) => Match.objectLike({
      IndexName: ix, KeySchema: [{ AttributeName: `${ix}PK`, KeyType: 'HASH' }, { AttributeName: `${ix}SK`, KeyType: 'RANGE' }],
    })),
  })
})

test('four arm64 Lambdas from one binary, each with its runtime role', () => {
  const t = synth()
  for (const rt of ['lambda-api', 'lambda-sweeper', 'lambda-ws', 'lambda-push']) {
    t.hasResourceProperties('AWS::Lambda::Function', {
      Runtime: 'provided.al2023', Architectures: ['arm64'], Handler: 'bootstrap',
      Environment: { Variables: Match.objectLike({ CD_RUNTIME: rt, CD_ENV: 'prod' }) },
    })
  }
  t.hasResourceProperties('AWS::Lambda::Function', {
    Environment: { Variables: Match.objectLike({ CD_RUNTIME: 'lambda-api', CD_CLIENT_IP_HEADER: 'CloudFront-Viewer-Address', CD_DEMO_SEED: 'false', CD_STORAGE_BUCKET: Match.anyValue() }) },
  })
})

test('push only wakes for job and shop-profile changes', () => {
  const t = synth()
  t.hasResourceProperties('AWS::Lambda::EventSourceMapping', {
    StartingPosition: 'LATEST', BisectBatchOnFunctionError: true,
    FilterCriteria: { Filters: [{ Pattern: '{"dynamodb":{"Keys":{"SK":{"S":["JOB"]}}}}' }, { Pattern: '{"dynamodb":{"Keys":{"SK":{"S":["PROFILE"]}}}}' }] },
  })
})

test('API behaviour adds the origin secret, forwards viewer headers, never caches', () => {
  const t = synth()
  const dists = t.findResources('AWS::CloudFront::Distribution')
  const cfg = (Object.values(dists)[0] as any).Properties.DistributionConfig
  const api = cfg.CacheBehaviors.find((b: any) => b.PathPattern === '/api/*')
  assert.ok(api, 'no /api/* behaviour')
  assert.equal(api.CachePolicyId, '4135ea2d-6df8-44a3-9df3-4b5a84be39ad') // CachingDisabled
  assert.equal(api.OriginRequestPolicyId, 'b689b0a8-53d0-40ab-baf2-68738e2966ac') // AllViewerExceptHostHeader
  const origin = cfg.Origins.find((o: any) => o.Id === api.TargetOriginId)
  assert.deepEqual(origin.OriginCustomHeaders, [{ HeaderName: 'X-Origin-Verify', HeaderValue: 'o'.repeat(64) }])
  assert.equal(cfg.PriceClass, 'PriceClass_200')
  assert.equal(cfg.DefaultCacheBehavior.FunctionAssociations.length, 1, 'SPA rewrite missing')
})

test('custom domain needs both name and certificate', () => {
  assert.throws(() => synth({ domainName: 'counterdrop.cloudsuggest.in' }))
  const t = synth({ domainName: 'counterdrop.cloudsuggest.in', certificateArn: 'arn:aws:acm:us-east-1:123456789012:certificate/abc', publicUrl: 'https://counterdrop.cloudsuggest.in' })
  t.hasResourceProperties('AWS::CloudFront::Distribution', { DistributionConfig: Match.objectLike({ Aliases: ['counterdrop.cloudsuggest.in'] }) })
  t.hasResourceProperties('AWS::S3::Bucket', { CorsConfiguration: { CorsRules: [Match.objectLike({ AllowedOrigins: ['https://counterdrop.cloudsuggest.in'] })] } })
})

test('hosted zone: stack owns A + AAAA alias records for its own name only', () => {
  const dom = { domainName: 'counterdrop.cloudsuggest.in', certificateArn: 'arn:aws:acm:us-east-1:123456789012:certificate/abc', publicUrl: 'https://counterdrop.cloudsuggest.in' }
  assert.equal(Object.keys(synth(dom).findResources('AWS::Route53::RecordSet')).length, 0, 'no zone id → no records')
  const t = synth({ ...dom, hostedZoneId: 'Z0123456789ABC' })
  for (const Type of ['A', 'AAAA']) {
    t.hasResourceProperties('AWS::Route53::RecordSet', {
      HostedZoneId: 'Z0123456789ABC', Name: 'counterdrop.cloudsuggest.in.', Type,
      AliasTarget: Match.objectLike({ HostedZoneId: Match.anyValue(), DNSName: Match.anyValue() }),
    })
  }
  t.resourceCountIs('AWS::Route53::RecordSet', 2)
  assert.throws(() => synth({ hostedZoneId: 'Z0123456789ABC' }), /HOSTED_ZONE_ID/)
  assert.throws(() => synth({ ...dom, hostedZoneId: 'Z0123456789ABC', hostedZoneName: 'example.com' }), /not inside/)
})

test('short secrets are refused', () => {
  assert.throws(() => synth({ realtimeKey: 'short' }), /CD_REALTIME_KEY/)
  assert.throws(() => synth({ originSecret: 'short' }), /CD_ORIGIN_SECRET/)
})
