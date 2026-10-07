// Counter Drop on AWS — the whole MVP in one stack (ADR-001, AWS-only revision).
//
//   phone/PC ──HTTPS──► CloudFront ─┬─ /*      ► S3 web bucket (PWA, private, OAC)
//                                   └─ /api/*  ► HTTP API ► Lambda api ─► DynamoDB cd-main, S3 files (presign)
//   phone/PC ──presigned PUT/GET──────────────► S3 files bucket (bytes never pass through Lambda)
//   phone/PC ──wss──► WebSocket API ► Lambda ws ─► DynamoDB cd-connections
//   cd-main stream ► Lambda push ─► WebSocket API (@connections)
//   EventBridge rule (1 min) ► Lambda sweeper ─► DynamoDB + S3 delete
//
// Everything is on-demand / pay-per-use: at MVP volume (1–3 shops) almost all of it sits in the free tier.
import {
  Aws, CfnOutput, Duration, RemovalPolicy, Stack, type StackProps,
  aws_apigatewayv2 as apigw, aws_apigatewayv2_integrations as integ,
  aws_budgets as budgets, aws_certificatemanager as acm, aws_cloudfront as cf,
  aws_cloudfront_origins as origins, aws_cloudwatch as cw, aws_cloudwatch_actions as cwActions,
  aws_dynamodb as ddb, aws_events as events, aws_events_targets as targets, aws_iam as iam,
  aws_lambda as lambda, aws_lambda_event_sources as sources, aws_logs as logs, aws_route53 as route53,
  aws_route53_targets as r53targets, aws_s3 as s3,
  aws_s3_deployment as s3deploy, aws_sns as sns, aws_sns_subscriptions as subs,
} from 'aws-cdk-lib'
import type { Construct } from 'constructs'

export interface CounterDropProps extends StackProps {
  /** Folder holding the linux/arm64 `bootstrap` built from api/cmd/lambda. */
  lambdaDir: string
  /** The built PWA (web/dist). */
  webDir: string
  /** Shared HMAC key for WebSocket tickets (≥ 32 chars). From GitHub secret CD_REALTIME_KEY. */
  realtimeKey: string
  /** Header value CloudFront adds so the API refuses requests that skip CloudFront. From GitHub secret CD_ORIGIN_SECRET. */
  originSecret: string
  /** Public site URL, e.g. https://counterdrop.cloudsuggest.in or https://dxxxx.cloudfront.net (see bin/app.ts). */
  publicUrl?: string
  /** Custom domain + ACM certificate in us-east-1 (both or neither). */
  domainName?: string
  certificateArn?: string
  /** Route 53 hosted zone holding domainName (e.g. the zone for cloudsuggest.in). When set, the stack owns the
   *  A + AAAA alias records for domainName → this CloudFront distribution. */
  hostedZoneId?: string
  /** That zone's name. Defaults to domainName minus its first label (counterdrop.cloudsuggest.in → cloudsuggest.in). */
  hostedZoneName?: string
  /** Extra browser origins allowed to upload (e.g. the CloudFront address after moving to the custom domain). */
  extraOrigins?: string[]
  /** Where alarm and budget emails go. */
  alarmEmail?: string
  /** Monthly budget alert in USD. */
  monthlyBudgetUsd: number
  tableName: string
  connectionsTableName: string
}

const GSIS = ['GSI1', 'GSI2', 'GSI3', 'GSI4'] // must match api/internal/store/ddbstore CreateTableInput

export class CounterDropStack extends Stack {
  constructor(scope: Construct, id: string, props: CounterDropProps) {
    super(scope, id, props)
    if (props.realtimeKey.length < 32) throw new Error('CD_REALTIME_KEY must be at least 32 characters')
    if (props.originSecret.length < 32) throw new Error('CD_ORIGIN_SECRET must be at least 32 characters')
    if (!!props.domainName !== !!props.certificateArn) throw new Error('Set both DOMAIN_NAME and CERTIFICATE_ARN, or neither')
    if (props.hostedZoneId && !props.domainName) throw new Error('HOSTED_ZONE_ID needs DOMAIN_NAME and CERTIFICATE_ARN')
    const zoneName = props.hostedZoneId
      ? (props.hostedZoneName || props.domainName!.split('.').slice(1).join('.')).replace(/\.$/, '')
      : undefined
    if (zoneName && !props.domainName!.endsWith(`.${zoneName}`) && props.domainName !== zoneName) {
      throw new Error(`DOMAIN_NAME ${props.domainName} is not inside hosted zone ${zoneName}`)
    }

    // ── Data ───────────────────────────────────────────────────────────────────────────────
    const table = new ddb.Table(this, 'Main', {
      tableName: props.tableName,
      partitionKey: { name: 'PK', type: ddb.AttributeType.STRING },
      sortKey: { name: 'SK', type: ddb.AttributeType.STRING },
      billingMode: ddb.BillingMode.PAY_PER_REQUEST,
      stream: ddb.StreamViewType.NEW_AND_OLD_IMAGES,
      timeToLiveAttribute: 'ttl',
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true, recoveryPeriodInDays: 7 },
      deletionProtection: true,
      // Kept on stack delete/replace, but cleaned up if the very first create rolls back (so a re-run works).
      removalPolicy: RemovalPolicy.RETAIN_ON_UPDATE_OR_DELETE,
    })
    for (const ix of GSIS) {
      table.addGlobalSecondaryIndex({
        indexName: ix,
        partitionKey: { name: `${ix}PK`, type: ddb.AttributeType.STRING },
        sortKey: { name: `${ix}SK`, type: ddb.AttributeType.STRING },
        projectionType: ddb.ProjectionType.ALL,
      })
    }

    const connections = new ddb.Table(this, 'Connections', {
      tableName: props.connectionsTableName,
      partitionKey: { name: 'PK', type: ddb.AttributeType.STRING },
      sortKey: { name: 'SK', type: ddb.AttributeType.STRING },
      billingMode: ddb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'ttl',
      removalPolicy: RemovalPolicy.DESTROY, // only live connection ids; nothing to keep
    })

    // Customer files. Private; phones PUT/GET with short presigned URLs. The app deletes files after
    // pickup; the lifecycle rule is only a backstop if the sweeper ever falls behind.
    const siteOrigin = props.publicUrl ? new URL(props.publicUrl).origin : undefined
    const extraOrigins = (props.extraOrigins ?? []).map((o) => new URL(o).origin).filter((o) => o !== siteOrigin)
    const files = new s3.Bucket(this, 'Files', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
      cors: [{
        allowedOrigins: siteOrigin ? [siteOrigin, ...extraOrigins] : ['https://*.cloudfront.net'],
        allowedMethods: [s3.HttpMethods.PUT, s3.HttpMethods.GET, s3.HttpMethods.HEAD],
        allowedHeaders: ['*'],
        exposedHeaders: ['ETag'],
        maxAge: 3000,
      }],
      lifecycleRules: [
        { id: 'deletion-backstop', prefix: 'cd/', expiration: Duration.days(8) },
        { id: 'abort-multipart', abortIncompleteMultipartUploadAfter: Duration.days(1) },
      ],
      removalPolicy: RemovalPolicy.RETAIN_ON_UPDATE_OR_DELETE,
    })

    // ── Lambdas (one Go binary, four roles) ─────────────────────────────────────────────────
    const code = lambda.Code.fromAsset(props.lambdaDir)
    const fn = (name: string, runtime: string, opts: { memory: number; timeout: Duration; env?: Record<string, string> }) => {
      const logGroup = new logs.LogGroup(this, `${name}Logs`, { retention: logs.RetentionDays.TWO_WEEKS, removalPolicy: RemovalPolicy.DESTROY })
      return new lambda.Function(this, name, {
        runtime: lambda.Runtime.PROVIDED_AL2023,
        architecture: lambda.Architecture.ARM_64,
        handler: 'bootstrap',
        code,
        memorySize: opts.memory,
        timeout: opts.timeout,
        logGroup,
        environment: {
          CD_RUNTIME: runtime,
          CD_ENV: 'prod',
          CD_LOG_LEVEL: 'info',
          CD_DYNAMODB_TABLE: table.tableName,
          CD_WS_CONNECTIONS_TABLE: connections.tableName,
          ...opts.env,
        },
      })
    }

    // WebSocket API first: the HTTP API Lambda needs its wss:// address.
    const wsFn = fn('Ws', 'lambda-ws', { memory: 256, timeout: Duration.seconds(10), env: { CD_REALTIME_KEY: props.realtimeKey } })
    connections.grantReadWriteData(wsFn)
    const wsIntegration = new integ.WebSocketLambdaIntegration('WsIntegration', wsFn)
    const wsApi = new apigw.WebSocketApi(this, 'WsApi', {
      apiName: 'counter-drop-live',
      connectRouteOptions: { integration: wsIntegration },
      disconnectRouteOptions: { integration: wsIntegration },
      defaultRouteOptions: { integration: wsIntegration },
    })
    const wsStage = new apigw.WebSocketStage(this, 'WsStage', {
      webSocketApi: wsApi, stageName: 'live', autoDeploy: true,
      throttle: { rateLimit: 50, burstLimit: 100 },
    })
    const wsHost = `${wsApi.apiId}.execute-api.${Aws.REGION}.${Aws.URL_SUFFIX}`
    const wsUrl = `wss://${wsHost}/${wsStage.stageName}`
    const wsManagement = `https://${wsHost}/${wsStage.stageName}`

    const storageEnv = {
      CD_STORAGE_BUCKET: files.bucketName,
      CD_STORAGE_REGION: Aws.REGION,
    }
    const apiFn = fn('Api', 'lambda-api', {
      memory: 512, // PIN hashing (PBKDF2) is CPU-bound; 512 MB ≈ ⅓ vCPU keeps sign-in fast
      timeout: Duration.seconds(15),
      env: {
        ...storageEnv,
        CD_REALTIME_WS_URL: wsUrl,
        CD_REALTIME_KEY: props.realtimeKey,
        CD_ORIGIN_SECRET: props.originSecret,
        CD_CLIENT_IP_HEADER: 'CloudFront-Viewer-Address',
        CD_RATE_LIMIT: 'true',
        CD_DEMO_SEED: 'false',
        ...(props.publicUrl ? {
          CD_PUBLIC_API_URL: props.publicUrl,
          CD_PUBLIC_WEB_URL: props.publicUrl,
          CD_WEB_ORIGINS: [props.publicUrl, ...extraOrigins].join(','),
        } : {}),
      },
    })
    table.grantReadWriteData(apiFn)
    files.grantReadWrite(apiFn) // presigned PUT/GET are signed with this role
    files.grantDelete(apiFn)

    const sweeperFn = fn('Sweeper', 'lambda-sweeper', { memory: 256, timeout: Duration.seconds(50), env: storageEnv })
    table.grantReadWriteData(sweeperFn)
    files.grantRead(sweeperFn) // HeadObject + ListBucket, so a missing object is a 404 not a 403
    files.grantDelete(sweeperFn)
    new events.Rule(this, 'SweeperSchedule', {
      description: 'Counter Drop deletion worker: abandon drafts, expire uncollected jobs, delete due files',
      schedule: events.Schedule.rate(Duration.minutes(1)),
      targets: [new targets.LambdaFunction(sweeperFn, { retryAttempts: 0 })],
    })
    // A failed run is simply picked up by the next minute's run; Lambda's own async retries would overlap it.
    // (No reserved concurrency: new accounts often have a 10-execution limit, which rejects any reservation.)
    sweeperFn.configureAsyncInvoke({ retryAttempts: 0, maxEventAge: Duration.seconds(60) })

    const pushFn = fn('Push', 'lambda-push', {
      memory: 256, timeout: Duration.seconds(30),
      env: { CD_REALTIME_KEY: props.realtimeKey, CD_WS_MANAGEMENT_ENDPOINT: wsManagement },
    })
    connections.grantReadWriteData(pushFn)
    pushFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['execute-api:ManageConnections'],
      resources: [`arn:${Aws.PARTITION}:execute-api:${Aws.REGION}:${Aws.ACCOUNT_ID}:${wsApi.apiId}/${wsStage.stageName}/POST/@connections/*`],
    }))
    pushFn.addEventSource(new sources.DynamoEventSource(table, {
      startingPosition: lambda.StartingPosition.LATEST,
      batchSize: 100,
      maxBatchingWindow: Duration.seconds(0),
      retryAttempts: 2,
      bisectBatchOnError: true,
      // Only jobs and shop profiles produce live updates; skip rate-limit counters, sessions, etc.
      filters: [lambda.FilterCriteria.filter({ dynamodb: { Keys: { SK: { S: lambda.FilterRule.isEqual('JOB') } } } }),
        lambda.FilterCriteria.filter({ dynamodb: { Keys: { SK: { S: lambda.FilterRule.isEqual('PROFILE') } } } })],
    }))

    // ── HTTP API (reached only through CloudFront: the Lambda checks X-Origin-Verify) ────────
    const httpApi = new apigw.HttpApi(this, 'HttpApi', {
      apiName: 'counter-drop-api',
      defaultIntegration: new integ.HttpLambdaIntegration('ApiIntegration', apiFn),
      createDefaultStage: false,
    })
    new apigw.HttpStage(this, 'HttpStage', {
      httpApi, stageName: '$default', autoDeploy: true,
      throttle: { rateLimit: 100, burstLimit: 200 },
    })
    const apiHost = `${httpApi.apiId}.execute-api.${Aws.REGION}.${Aws.URL_SUFFIX}`

    // ── Web (S3 + CloudFront) ───────────────────────────────────────────────────────────────
    const web = new s3.Bucket(this, 'Web', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    })

    // Deep links (/s/<slug>, /shop/board, /t/<id>) are client routes: serve index.html for any path
    // without a file extension. Done per-behaviour so API 404s stay JSON.
    const spaRewrite = new cf.Function(this, 'SpaRewrite', {
      runtime: cf.FunctionRuntime.JS_2_0,
      code: cf.FunctionCode.fromInline(`function handler(event) {
  var r = event.request;
  var last = r.uri.split('/').pop();
  if (last.indexOf('.') === -1) { r.uri = '/index.html'; }
  return r;
}`),
    })

    // The PWA's Content-Security-Policy (the API sets its own on API responses).
    const s3Regional = `https://${files.bucketName}.s3.${Aws.REGION}.${Aws.URL_SUFFIX}`
    const csp = [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "font-src 'self' data:",
      `connect-src 'self' ${s3Regional} https://s3.${Aws.REGION}.${Aws.URL_SUFFIX} wss://${wsHost}`,
      "worker-src 'self' blob:",
      "media-src 'self' blob:",
      "manifest-src 'self'",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
    ].join('; ')
    const webHeaders = new cf.ResponseHeadersPolicy(this, 'WebHeaders', {
      securityHeadersBehavior: {
        contentSecurityPolicy: { contentSecurityPolicy: csp, override: true },
        strictTransportSecurity: { accessControlMaxAge: Duration.days(365), includeSubdomains: false, override: true },
        contentTypeOptions: { override: true },
        frameOptions: { frameOption: cf.HeadersFrameOption.DENY, override: true },
        referrerPolicy: { referrerPolicy: cf.HeadersReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN, override: true },
      },
      customHeadersBehavior: {
        customHeaders: [{ header: 'Permissions-Policy', value: 'camera=(self), microphone=(), geolocation=()', override: true }],
      },
    })

    const certificate = props.certificateArn ? acm.Certificate.fromCertificateArn(this, 'Cert', props.certificateArn) : undefined
    const distribution = new cf.Distribution(this, 'Site', {
      comment: 'Counter Drop',
      priceClass: cf.PriceClass.PRICE_CLASS_200, // includes India edges; PRICE_CLASS_100 does not
      httpVersion: cf.HttpVersion.HTTP2_AND_3,
      minimumProtocolVersion: certificate ? cf.SecurityPolicyProtocol.TLS_V1_2_2021 : undefined,
      defaultRootObject: 'index.html',
      domainNames: props.domainName ? [props.domainName] : undefined,
      certificate,
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(web),
        viewerProtocolPolicy: cf.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cf.CachePolicy.CACHING_OPTIMIZED,
        responseHeadersPolicy: webHeaders,
        compress: true,
        functionAssociations: [{ function: spaRewrite, eventType: cf.FunctionEventType.VIEWER_REQUEST }],
      },
      additionalBehaviors: {
        '/api/*': {
          origin: new origins.HttpOrigin(apiHost, {
            protocolPolicy: cf.OriginProtocolPolicy.HTTPS_ONLY,
            customHeaders: { 'X-Origin-Verify': props.originSecret },
            readTimeout: Duration.seconds(30),
          }),
          viewerProtocolPolicy: cf.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          allowedMethods: cf.AllowedMethods.ALLOW_ALL,
          cachePolicy: cf.CachePolicy.CACHING_DISABLED,
          // Every viewer header (Authorization, X-Ticket-Secret, …) plus CloudFront-Viewer-Address, minus Host.
          originRequestPolicy: cf.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
          compress: true,
        },
      },
    })

    // Hashed assets: cache for a year. index.html, the service worker and manifest: always revalidate.
    // Icons and screenshots keep their names between builds, so they must revalidate too.
    const noCache = ['index.html', 'sw.js', 'registerSW.js', 'manifest.webmanifest', 'workbox-*.js', '*.png', '*.svg', 'screenshots', 'screenshots/**']
    const assets = new s3deploy.BucketDeployment(this, 'WebAssets', {
      sources: [s3deploy.Source.asset(props.webDir, { exclude: noCache })],
      destinationBucket: web,
      prune: false, // keep old hashed files so open tabs and old service workers still load
      cacheControl: [s3deploy.CacheControl.fromString('public, max-age=31536000, immutable')],
      memoryLimit: 512,
    })
    const shell = new s3deploy.BucketDeployment(this, 'WebShell', {
      sources: [s3deploy.Source.asset(props.webDir, { exclude: ['*'].concat(noCache.map((f) => `!${f}`)) })],
      destinationBucket: web,
      prune: false,
      cacheControl: [s3deploy.CacheControl.fromString('no-cache')],
      distribution,
      distributionPaths: ['/*'], // one wildcard path counts as one invalidation (1,000/month free)
      memoryLimit: 512,
    })
    shell.node.addDependency(assets) // upload the new hashed files before the page that points at them

    // ── Alarms and budget ───────────────────────────────────────────────────────────────────
    const topic = new sns.Topic(this, 'Alarms', { displayName: 'Counter Drop alarms' })
    if (props.alarmEmail) topic.addSubscription(new subs.EmailSubscription(props.alarmEmail))
    const alarm = (id: string, metric: cw.IMetric, threshold: number, periods: number, desc: string) => {
      const a = new cw.Alarm(this, id, {
        metric, threshold, evaluationPeriods: periods, datapointsToAlarm: periods,
        comparisonOperator: cw.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cw.TreatMissingData.NOT_BREACHING, alarmDescription: desc,
      })
      a.addAlarmAction(new cwActions.SnsAction(topic))
    }
    const five = Duration.minutes(5)
    alarm('ApiErrors', apiFn.metricErrors({ period: five }), 5, 1, 'API Lambda errors (crashes/timeouts), 5+ in 5 minutes')
    alarm('Api5xx', new cw.Metric({ namespace: 'AWS/ApiGateway', metricName: '5xx', dimensionsMap: { ApiId: httpApi.apiId, Stage: '$default' }, statistic: 'Sum', period: five }),
      10, 1, 'HTTP API 5xx responses, 10+ in 5 minutes')
    alarm('SweeperFailing', sweeperFn.metricErrors({ period: five }), 1, 3, 'Deletion worker failing for 15 minutes: customer files may not be deleted on time')
    alarm('PushErrors', pushFn.metricErrors({ period: five }), 5, 2, 'Live-update push Lambda failing')
    alarm('DynamoThrottles', table.metricThrottledRequestsForOperations({ period: five, operations: [ddb.Operation.GET_ITEM, ddb.Operation.PUT_ITEM, ddb.Operation.UPDATE_ITEM, ddb.Operation.DELETE_ITEM, ddb.Operation.QUERY, ddb.Operation.TRANSACT_WRITE_ITEMS] }), 1, 1, 'DynamoDB requests throttled')

    if (props.alarmEmail) {
      new budgets.CfnBudget(this, 'Budget', {
        budget: {
          budgetName: `counter-drop-monthly-${Aws.REGION}`,
          budgetType: 'COST', timeUnit: 'MONTHLY',
          budgetLimit: { amount: props.monthlyBudgetUsd, unit: 'USD' },
        },
        notificationsWithSubscribers: [
          { notification: { notificationType: 'ACTUAL', comparisonOperator: 'GREATER_THAN', threshold: 80 }, subscribers: [{ subscriptionType: 'EMAIL', address: props.alarmEmail }] },
          { notification: { notificationType: 'FORECASTED', comparisonOperator: 'GREATER_THAN', threshold: 100 }, subscribers: [{ subscriptionType: 'EMAIL', address: props.alarmEmail }] },
        ],
      })
    }

    // ── DNS (optional) ──────────────────────────────────────────────────────────────────────
    // The zone is shared by every app on the domain; this stack only owns its own name's records.
    // deleteExisting replaces a record made by hand (e.g. an old A record) instead of failing the deploy.
    if (props.hostedZoneId && zoneName) {
      const zone = route53.HostedZone.fromHostedZoneAttributes(this, 'Zone', { hostedZoneId: props.hostedZoneId, zoneName })
      const target = route53.RecordTarget.fromAlias(new r53targets.CloudFrontTarget(distribution))
      const recordName = `${props.domainName}.`
      new route53.ARecord(this, 'SiteA', { zone, recordName, target, deleteExisting: true, comment: 'Counter Drop (managed by CDK)' })
      new route53.AaaaRecord(this, 'SiteAAAA', { zone, recordName, target, deleteExisting: true, comment: 'Counter Drop (managed by CDK)' })
    }

    // ── Outputs ─────────────────────────────────────────────────────────────────────────────
    const cfUrl = `https://${distribution.distributionDomainName}`
    new CfnOutput(this, 'SiteUrl', { value: props.domainName ? `https://${props.domainName}` : cfUrl })
    new CfnOutput(this, 'CloudFrontUrl', { value: cfUrl, description: props.hostedZoneId ? 'DNS alias managed by this stack' : 'Point the custom domain CNAME here' })
    new CfnOutput(this, 'WebSocketUrl', { value: wsUrl })
    new CfnOutput(this, 'HttpApiUrl', { value: `https://${apiHost}`, description: 'Refuses requests without X-Origin-Verify (use the site URL)' })
    new CfnOutput(this, 'TableName', { value: table.tableName })
    new CfnOutput(this, 'FilesBucket', { value: files.bucketName })
    new CfnOutput(this, 'ApiFunction', { value: apiFn.functionName })
  }
}
