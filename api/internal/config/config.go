package config

import (
	"log/slog"
	"os"
	"strconv"
	"strings"
	"time"
)

type Config struct {
	Env          string // dev | staging | prod
	Addr         string
	PublicAPIURL string // origin customers' phones use to reach the API (for local storage URLs)
	Dynamo       DynamoConfig
	LogLevel     slog.Level
	WebOrigins   []string // allowed CORS origins
	WebDir       string   // optional: serve the built PWA from this folder

	Storage StorageConfig

	Realtime RealtimeConfig

	UndoWindow       time.Duration
	AbandonAfter     time.Duration
	DeletionInterval time.Duration
	MaxFileBytes     int64
	MaxJobBytes      int64
	MaxFiles         int
	SessionTTL       time.Duration
	SetupLinkTTL     time.Duration
	DemoSeed         bool

	// PublicWebURL is where people open the PWA; used in setup links printed by cdadmin.
	PublicWebURL string

	// RateLimit turns on per-IP request limits (on by default). TrustProxy makes the API take the
	// client IP from X-Forwarded-For; set it only behind a proxy that sets that header (ALB, Caddy).
	RateLimit  bool
	TrustProxy bool
	// ClientIPHeader names a header set by the CDN that holds the viewer's address, e.g.
	// "CloudFront-Viewer-Address" (ip:port). Only set it when requests can reach the API solely
	// through that CDN (see OriginSecret).
	ClientIPHeader string
	// OriginSecret, when set, must arrive in X-Origin-Verify on every request. CloudFront adds it,
	// so nobody can call the API Gateway URL directly and bypass the CDN and its client-IP header.
	OriginSecret string
}

// DynamoConfig configures the DynamoDB table that holds all data (ADR-001). Endpoint is only for
// DynamoDB Local in dev and tests; on AWS the SDK resolves it and credentials come from the Lambda role.
type DynamoConfig struct {
	Table    string
	Region   string
	Endpoint string
}

// RealtimeConfig chooses how browsers get live updates.
//
//	WSURL ""        Server-Sent Events from this API (default; one process)
//	WSURL "local"   WebSocket served by this API at /ws (dev: exercises the same client code as AWS)
//	WSURL "wss://…" API Gateway WebSocket (AWS, ADR-001); pushes come from the DynamoDB stream
//
// Key signs the short-lived connection tickets; the WebSocket Lambda must have the same key.
type RealtimeConfig struct {
	WSURL              string
	Key                string
	ConnectionsTable   string
	ManagementEndpoint string // https://<api-id>.execute-api.<region>.amazonaws.com/<stage> (push Lambda)
}

type StorageConfig struct {
	// S3 / R2
	Endpoint  string
	Region    string
	Bucket    string
	AccessKey string
	SecretKey string
	// Local disk (dev / single-box pilot)
	Dir        string
	SigningKey string

	PutTTL time.Duration
	GetTTL time.Duration
}

func (c StorageConfig) S3Enabled() bool {
	return c.Bucket != ""
}

func Load() Config {
	env := str("CD_ENV", "dev")
	return Config{
		Env:          env,
		Addr:         str("CD_API_ADDR", ":8080"),
		PublicAPIURL: str("CD_PUBLIC_API_URL", "http://localhost:8080"),
		Dynamo: DynamoConfig{
			Table:    str("CD_DYNAMODB_TABLE", "cd-main"),
			Region:   str("CD_DYNAMODB_REGION", str("AWS_REGION", "ap-south-1")),
			Endpoint: str("CD_DYNAMODB_ENDPOINT", ""),
		},
		LogLevel:   parseLogLevel(str("CD_LOG_LEVEL", "info")),
		WebOrigins: list("CD_WEB_ORIGINS", "http://localhost:5173"),
		WebDir:     str("CD_WEB_DIR", ""),
		Storage: StorageConfig{
			Endpoint:   str("CD_STORAGE_ENDPOINT", ""),
			Region:     str("CD_STORAGE_REGION", "auto"),
			Bucket:     str("CD_STORAGE_BUCKET", ""),
			AccessKey:  str("CD_STORAGE_ACCESS_KEY", ""),
			SecretKey:  str("CD_STORAGE_SECRET_KEY", ""),
			Dir:        str("CD_STORAGE_DIR", ".data/files"),
			SigningKey: str("CD_STORAGE_SIGNING_KEY", ""),
			PutTTL:     dur("CD_STORAGE_PUT_TTL", 15*time.Minute),
			GetTTL:     dur("CD_STORAGE_GET_TTL", 5*time.Minute),
		},
		Realtime: RealtimeConfig{
			WSURL:              strings.TrimRight(str("CD_REALTIME_WS_URL", ""), "/"),
			Key:                str("CD_REALTIME_KEY", ""),
			ConnectionsTable:   str("CD_WS_CONNECTIONS_TABLE", "cd-connections"),
			ManagementEndpoint: str("CD_WS_MANAGEMENT_ENDPOINT", ""),
		},
		UndoWindow:       dur("CD_UNDO_WINDOW", 10*time.Minute),
		AbandonAfter:     dur("CD_ABANDON_AFTER", 60*time.Minute),
		DeletionInterval: dur("CD_DELETION_INTERVAL", 30*time.Second),
		MaxFileBytes:     int64(num("CD_MAX_FILE_MB", 500)) << 20,
		MaxJobBytes:      int64(num("CD_MAX_JOB_MB", 500)) << 20,
		MaxFiles:         num("CD_MAX_FILES", 20),
		SessionTTL:       dur("CD_SESSION_TTL", 12*time.Hour),
		SetupLinkTTL:     dur("CD_SETUP_LINK_TTL", 48*time.Hour),
		DemoSeed:         boolean("CD_DEMO_SEED", env == "dev"),
		PublicWebURL:     strings.TrimRight(str("CD_PUBLIC_WEB_URL", defaultWebURL()), "/"),
		RateLimit:        boolean("CD_RATE_LIMIT", true),
		TrustProxy:       boolean("CD_TRUST_PROXY", false),
		ClientIPHeader:   str("CD_CLIENT_IP_HEADER", ""),
		OriginSecret:     str("CD_ORIGIN_SECRET", ""),
	}
}

// defaultWebURL: the API itself when it serves the PWA, otherwise the Vite dev server.
func defaultWebURL() string {
	if str("CD_WEB_DIR", "") != "" {
		return str("CD_PUBLIC_API_URL", "http://localhost:8080")
	}
	return strings.Split(str("CD_WEB_ORIGINS", "http://localhost:5173"), ",")[0]
}

// SetupURL is the full link a person opens to choose their PIN. The token is in the fragment,
// so it never reaches server logs or Referer headers.
func (c Config) SetupURL(token string) string {
	return c.PublicWebURL + "/shop/setup#" + token
}

func str(key, fallback string) string {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		return v
	}
	return fallback
}

func list(key, fallback string) []string {
	var out []string
	for _, p := range strings.Split(str(key, fallback), ",") {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	return out
}

func dur(key string, fallback time.Duration) time.Duration {
	if d, err := time.ParseDuration(str(key, "")); err == nil {
		return d
	}
	return fallback
}

func num(key string, fallback int) int {
	if n, err := strconv.Atoi(str(key, "")); err == nil {
		return n
	}
	return fallback
}

func boolean(key string, fallback bool) bool {
	if b, err := strconv.ParseBool(str(key, "")); err == nil {
		return b
	}
	return fallback
}

func parseLogLevel(value string) slog.Level {
	switch strings.ToLower(value) {
	case "debug":
		return slog.LevelDebug
	case "warn", "warning":
		return slog.LevelWarn
	case "error":
		return slog.LevelError
	default:
		return slog.LevelInfo
	}
}
