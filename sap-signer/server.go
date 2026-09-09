package main

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"mime"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/majd/ipatool/v2/internal/sap"
)

const (
	defaultSetupURL       = "https://fpinit.itunes.apple.com/v1/signSapSetup/legacy"
	defaultCertificateURL = "https://s.mzstatic.com/sap/setupCert.plist"
	maxSigningBytes       = 1 << 20
	maxEncodedBytes       = (maxSigningBytes + 2) / 3 * 4
	maxRequestBytes       = maxEncodedBytes + 1024
	signerTTL             = 10 * time.Minute
	signRequestTimeout    = 5 * time.Minute
	initializationTimeout = 5 * time.Minute
)

var (
	errServiceClosed     = errors.New("SAP service is shutting down")
	errSignerUnavailable = errors.New("SAP signer could not be initialized")
	errSigningFailed     = errors.New("SAP signing failed")
)

func contextError(ctx context.Context) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if deadline, ok := ctx.Deadline(); ok && !time.Now().Before(deadline) {
		return context.DeadlineExceeded
	}
	return nil
}

type signerFactory func(context.Context, sap.Config) (sap.ActionSigner, error)

type signingService struct {
	tokenHash      [sha256.Size]byte
	config         sap.Config
	factory        signerFactory
	gate           chan struct{}
	now            func() time.Time
	requestTimeout time.Duration

	// The gate protects the cached signer, including every native Sign and Close call.
	signer   sap.ActionSigner
	guid     string
	lastUsed time.Time
	closed   bool
}

func newSigningService(token string, config sap.Config, factory signerFactory) (*signingService, error) {
	if len(token) < 32 || strings.ContainsAny(token, " \t\r\n") {
		return nil, errors.New("SAP_API_TOKEN must contain at least 32 characters without whitespace")
	}
	for name, endpoint := range map[string]string{
		"SAP_SETUP_URL":       config.SetupURL,
		"SAP_CERTIFICATE_URL": config.CertificateURL,
	} {
		parsed, err := url.Parse(endpoint)
		if err != nil || parsed.Scheme != "https" || parsed.Hostname() == "" || parsed.User != nil || parsed.Fragment != "" {
			return nil, fmt.Errorf("%s must be an absolute HTTPS URL without user information or a fragment", name)
		}
	}
	if config.Version != 200 {
		return nil, errors.New("SAP version must be 200")
	}
	if factory == nil {
		factory = sap.NewSigner
	}
	return &signingService{
		tokenHash:      sha256.Sum256([]byte(token)),
		config:         config,
		factory:        factory,
		gate:           make(chan struct{}, 1),
		now:            time.Now,
		requestTimeout: signRequestTimeout,
	}, nil
}

func (s *signingService) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	switch r.URL.Path {
	case "/healthz":
		if r.Method != http.MethodGet {
			w.Header().Set("Allow", http.MethodGet)
			writeError(w, http.StatusMethodNotAllowed, "method_not_allowed", "use GET for this endpoint")
			return
		}
		// This is a process health probe. Signer initialization is deliberately lazy.
		writeJSON(w, http.StatusOK, struct {
			Status string `json:"status"`
		}{Status: "ok"})
	case "/sign":
		if r.Method != http.MethodPost {
			w.Header().Set("Allow", http.MethodPost)
			writeError(w, http.StatusMethodNotAllowed, "method_not_allowed", "use POST for this endpoint")
			return
		}
		s.handleSign(w, r)
	default:
		writeError(w, http.StatusNotFound, "not_found", "endpoint not found")
	}
}

func (s *signingService) authorized(r *http.Request) bool {
	values := r.Header.Values("Authorization")
	if len(values) != 1 {
		return false
	}
	scheme, token, ok := strings.Cut(values[0], " ")
	if !ok || !strings.EqualFold(scheme, "Bearer") {
		return false
	}
	hash := sha256.Sum256([]byte(token))
	return subtle.ConstantTimeCompare(hash[:], s.tokenHash[:]) == 1
}

func (s *signingService) handleSign(w http.ResponseWriter, r *http.Request) {
	if !s.authorized(r) {
		w.Header().Set("WWW-Authenticate", "Bearer")
		writeError(w, http.StatusUnauthorized, "unauthorized", "a valid bearer token is required")
		return
	}
	mediaType, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || mediaType != "application/json" {
		writeError(w, http.StatusUnsupportedMediaType, "unsupported_media_type", "Content-Type must be application/json")
		return
	}

	r.Body = http.MaxBytesReader(w, r.Body, maxRequestBytes)
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	var input struct {
		GUID       string `json:"guid"`
		BodyBase64 string `json:"bodyBase64"`
	}
	if err := decoder.Decode(&input); err != nil {
		writeJSONError(w, err)
		return
	}
	var trailing json.RawMessage
	if err := decoder.Decode(&trailing); err != io.EOF {
		writeJSONError(w, err)
		return
	}
	if len(input.GUID) < 2 || len(input.GUID) > 40 || len(input.GUID)%2 != 0 {
		writeError(w, http.StatusBadRequest, "invalid_guid", "guid must encode 1 to 20 bytes as hexadecimal")
		return
	}
	hardware, err := hex.DecodeString(input.GUID)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid_guid", "guid must encode 1 to 20 bytes as hexadecimal")
		return
	}
	if len(input.BodyBase64) > maxEncodedBytes {
		writeError(w, http.StatusRequestEntityTooLarge, "request_too_large", "bodyBase64 must encode no more than 1 MiB")
		return
	}
	body, err := base64.StdEncoding.Strict().DecodeString(input.BodyBase64)
	if err != nil || strings.ContainsAny(input.BodyBase64, "\r\n") || len(body) == 0 {
		writeError(w, http.StatusBadRequest, "invalid_body", "bodyBase64 must be nonempty, canonical standard Base64")
		return
	}
	if len(body) > maxSigningBytes {
		writeError(w, http.StatusRequestEntityTooLarge, "request_too_large", "bodyBase64 must encode no more than 1 MiB")
		return
	}
	guid := strings.ToUpper(input.GUID)
	ctx, cancel := context.WithTimeout(r.Context(), s.requestTimeout)
	defer cancel()
	signature, err := s.sign(ctx, guid, hardware, body)
	if err != nil {
		if !errors.Is(err, context.Canceled) && !errors.Is(err, context.DeadlineExceeded) && !errors.Is(err, errServiceClosed) {
			// SAP errors describe network/cache/runtime failures; never add request fields here.
			log.Printf("SAP operation failed: %q", err.Error())
		}
		switch {
		case errors.Is(err, context.DeadlineExceeded):
			writeError(w, http.StatusGatewayTimeout, "signer_timeout", "SAP signing timed out")
		case errors.Is(err, context.Canceled):
			writeError(w, http.StatusRequestTimeout, "request_canceled", "request was canceled")
		case errors.Is(err, errServiceClosed):
			writeError(w, http.StatusServiceUnavailable, "shutting_down", "SAP service is shutting down")
		case errors.Is(err, errSigningFailed):
			writeError(w, http.StatusBadGateway, "signing_failed", "SAP signing failed; retry the request")
		default:
			writeError(w, http.StatusBadGateway, "signer_unavailable", "SAP signer could not be initialized; retry later")
		}
		return
	}
	writeJSON(w, http.StatusOK, struct {
		Signature   string `json:"signature"`
		BytesSigned int    `json:"bytesSigned"`
		GUID        string `json:"guid"`
	}{Signature: base64.StdEncoding.EncodeToString(signature), BytesSigned: len(body), GUID: guid})
}

func (s *signingService) acquire(ctx context.Context) error {
	if err := contextError(ctx); err != nil {
		return err
	}
	select {
	case <-ctx.Done():
		return ctx.Err()
	case s.gate <- struct{}{}:
		if err := contextError(ctx); err != nil {
			<-s.gate
			return err
		}
		return nil
	}
}

func (s *signingService) sign(ctx context.Context, guid string, hardware, body []byte) ([]byte, error) {
	if err := s.acquire(ctx); err != nil {
		return nil, err
	}
	defer func() { <-s.gate }()
	if s.closed {
		return nil, errServiceClosed
	}
	if s.signer != nil && (s.guid != guid || s.now().Sub(s.lastUsed) >= signerTTL) {
		if err := s.closeSigner(); err != nil {
			return nil, fmt.Errorf("%w: %w", errSignerUnavailable, err)
		}
	}
	if s.signer == nil {
		config := s.config
		config.HardwareID = append([]byte(nil), hardware...)
		initCtx, cancel := context.WithTimeout(ctx, initializationTimeout)
		candidate, err := s.factory(initCtx, config)
		contextErr := contextError(initCtx)
		cancel()
		if err != nil || contextErr != nil {
			if candidate != nil {
				_ = candidate.Close()
			}
			if contextErr != nil {
				return nil, contextErr
			}
			return nil, fmt.Errorf("%w: %w", errSignerUnavailable, err)
		}
		if candidate == nil {
			return nil, errSignerUnavailable
		}
		s.signer, s.guid = candidate, guid
	}
	if err := contextError(ctx); err != nil {
		return nil, err
	}
	// Keep the gate until Sign returns, even if the client cancels in the meantime.
	signature, err := s.signer.Sign(body)
	if err != nil || len(signature) == 0 {
		_ = s.closeSigner()
		if err == nil {
			err = errors.New("empty signature")
		}
		return nil, fmt.Errorf("%w: %w", errSigningFailed, err)
	}
	s.lastUsed = s.now()
	if err := contextError(ctx); err != nil {
		return nil, err
	}
	return signature, nil
}

func (s *signingService) closeSigner() error {
	signer := s.signer
	s.signer, s.guid, s.lastUsed = nil, "", time.Time{}
	if signer != nil {
		return signer.Close()
	}
	return nil
}

func (s *signingService) Close(ctx context.Context) error {
	if err := s.acquire(ctx); err != nil {
		return err
	}
	defer func() { <-s.gate }()
	s.closed = true
	return s.closeSigner()
}

func writeJSONError(w http.ResponseWriter, err error) {
	var limitError *http.MaxBytesError
	if errors.As(err, &limitError) {
		writeError(w, http.StatusRequestEntityTooLarge, "request_too_large", "JSON request body is too large")
		return
	}
	writeError(w, http.StatusBadRequest, "invalid_json", "expected one JSON object containing only guid and bodyBase64")
}

func writeError(w http.ResponseWriter, status int, code, message string) {
	writeJSON(w, status, struct {
		Error   string `json:"error"`
		Message string `json:"message"`
	}{Error: code, Message: message})
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}
