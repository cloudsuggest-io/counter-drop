// Package storage holds uploaded files. The API never streams file bytes itself in production:
// clients upload with presigned PUT URLs and staff read with short-lived GET URLs.
package storage

import (
	"context"
	"errors"
	"fmt"
	"regexp"
	"time"
)

var ErrObjectNotFound = errors.New("object not found")

type ObjectInfo struct {
	Size        int64
	ContentType string
}

// ObjectStore is implemented by S3Store (Cloudflare R2 / S3 / MinIO) and LocalStore (dev).
type ObjectStore interface {
	// PresignPut returns a URL and the headers the client must send with its PUT.
	PresignPut(ctx context.Context, key, contentType string, size int64) (url string, headers map[string]string, err error)
	// PresignGet returns a short-lived URL to read the object: shown in the browser (inline) for printing,
	// or saved to disk (attachment) when download is true. Responses are never cached.
	PresignGet(ctx context.Context, key, filename, contentType string, download bool) (string, error)
	Head(ctx context.Context, key string) (ObjectInfo, error)
	// Delete removes the object; a missing object is not an error.
	Delete(ctx context.Context, key string) error
}

var idPattern = regexp.MustCompile(`^[A-Za-z0-9_-]+$`)

// FileKey builds "cd/{shop}/{job}/{file}". Keys never contain file names or customer data.
func FileKey(shopID, jobID, fileID string) (string, error) {
	for _, id := range []string{shopID, jobID, fileID} {
		if !idPattern.MatchString(id) {
			return "", fmt.Errorf("invalid id in object key: %q", id)
		}
	}
	return fmt.Sprintf("cd/%s/%s/%s", shopID, jobID, fileID), nil
}

// OrderFileKey builds "ord/{shop}/{order}/{file}" for files of multi-day orders (blackbooks). They are
// kept up to 30 days, so they live under their own prefix with a longer lifecycle backstop.
func OrderFileKey(shopID, orderID, fileID string) (string, error) {
	for _, id := range []string{shopID, orderID, fileID} {
		if !idPattern.MatchString(id) {
			return "", fmt.Errorf("invalid id in object key: %q", id)
		}
	}
	return fmt.Sprintf("ord/%s/%s/%s", shopID, orderID, fileID), nil
}

type Durations struct {
	PutTTL time.Duration
	GetTTL time.Duration
}
