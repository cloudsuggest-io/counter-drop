package httpapi

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"

	"counter-drop/api/internal/domain"
	"counter-drop/api/internal/store"
)

type apiError struct {
	Code    string         `json:"code"`
	Message string         `json:"message"`
	Details map[string]any `json:"details,omitempty"`
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeData(w http.ResponseWriter, status int, v any) {
	writeJSON(w, status, map[string]any{"data": v})
}

var errBadRequest = errors.New("bad request")

// mapError turns store/domain errors into a status, a stable code (FSD §16) and a safe message.
func mapError(err error) (int, string, string) {
	switch {
	case errors.Is(err, errBadRequest):
		return 400, "bad_request", strings.TrimPrefix(err.Error(), "bad request: ")
	case errors.Is(err, store.ErrNotFound):
		return 404, "not_found", "Not found."
	case errors.Is(err, store.ErrBadSecret):
		return 403, "forbidden", "Open this ticket from the phone that sent the files."
	case errors.Is(err, store.ErrUnauthorized):
		return 401, "unauthorized", "Please sign in again."
	case errors.Is(err, store.ErrShopPaused):
		return 409, "shop_paused", "The counter is very busy right now. Please try again in a few minutes."
	case errors.Is(err, store.ErrShopOffline):
		return 409, "shop_offline", "This shop isn't taking jobs right now."
	case errors.Is(err, store.ErrAlreadyClaimed):
		return 409, "already_claimed", "Another counter took this job."
	case errors.Is(err, store.ErrLaneEmpty):
		return 404, "lane_empty", "Nothing waiting in this lane."
	case errors.Is(err, store.ErrUploadsIncomplete):
		return 409, "uploads_incomplete", "Wait for all files to finish uploading."
	case errors.Is(err, store.ErrPriceChanged):
		return 409, "price_changed", "The price changed. Please check and send again."
	case errors.Is(err, store.ErrBadPIN):
		return 401, "bad_pin", "That PIN didn't match."
	case errors.Is(err, store.ErrLocked):
		return 429, "locked", "Too many wrong PINs. Try again in 15 minutes."
	case errors.Is(err, store.ErrSetupPending):
		return 401, "setup_pending", "Finish setting up with the link you were sent, then sign in."
	case errors.Is(err, store.ErrLinkInvalid):
		return 410, "link_invalid", "This link has expired or was already used. Ask the shop owner for a new one."
	case errors.Is(err, store.ErrWeakPIN):
		return 422, "weak_pin", "That PIN is too easy to guess. Avoid 1234, 1111, 1212 and similar."
	case errors.Is(err, store.ErrSamePIN):
		return 422, "same_pin", "Choose a PIN different from your current one."
	case errors.Is(err, store.ErrLastOwner):
		return 409, "last_owner", "A shop needs at least one owner."
	case errors.Is(err, store.ErrSelf):
		return 409, "self", "You can't do this to your own account. Use Change PIN instead."
	case errors.Is(err, store.ErrNotEditable):
		return 409, "not_editable", "This job is being printed and can't be changed."
	case errors.Is(err, domain.ErrInvalidTransition):
		return 409, "invalid_transition", "That action isn't possible for this job any more."
	case errors.Is(err, domain.ErrReasonRequired):
		return 422, "reason_required", "Add a reason."
	case errors.Is(err, domain.ErrWindowExpired):
		return 409, "undo_expired", "The 10-minute undo window has passed."
	case errors.Is(err, domain.ErrPageRange):
		return 422, "page_range", "Pages must look like 1-3,5 and be within the document."
	case errors.Is(err, domain.ErrOptionUnavailable):
		return 422, "option_unavailable", "This shop doesn't offer colour printing."
	case errors.Is(err, domain.ErrPriceRequired):
		return 422, "price_required", "Enter the price for the Other files before marking this ready."
	case errors.Is(err, domain.ErrPagesRequired):
		return 422, "pages_required", "Enter the page count for each document before marking this ready."
	case errors.Is(err, domain.ErrValidation):
		return 422, "validation", strings.TrimPrefix(err.Error(), domain.ErrValidation.Error()+": ")
	}
	return 500, "internal_error", "Something went wrong. Please try again."
}

func (s *Server) fail(w http.ResponseWriter, r *http.Request, err error) {
	status, code, msg := mapError(err)
	if status >= 500 {
		s.Logger.Error("request failed", "request_id", requestID(r.Context()), "path", r.URL.Path, "error", err)
	}
	writeJSON(w, status, map[string]any{"error": apiError{Code: code, Message: msg}})
}

func failCode(w http.ResponseWriter, status int, code, msg string) {
	writeJSON(w, status, map[string]any{"error": apiError{Code: code, Message: msg}})
}

// decode reads a JSON body strictly (unknown fields rejected, 1 MiB cap).
func decode(r *http.Request, dst any) error {
	dec := json.NewDecoder(io.LimitReader(r.Body, 1<<20))
	dec.DisallowUnknownFields()
	if err := dec.Decode(dst); err != nil {
		if errors.Is(err, io.EOF) {
			return fmt.Errorf("%w: empty body", errBadRequest)
		}
		return fmt.Errorf("%w: %v", errBadRequest, err)
	}
	return nil
}
