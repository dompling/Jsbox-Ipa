package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/majd/ipatool/v2/internal/sap"
)

const testToken = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"

type stubSigner struct {
	sign  func([]byte) ([]byte, error)
	close func() error
}

func (s *stubSigner) Sign(body []byte) ([]byte, error) {
	if s.sign != nil {
		return s.sign(body)
	}
	return []byte{0x01, 0x80, 0xff}, nil
}

func (s *stubSigner) Close() error {
	if s.close != nil {
		return s.close()
	}
	return nil
}

func testService(t *testing.T, factory signerFactory) *signingService {
	t.Helper()
	s, err := newSigningService(testToken, sap.Config{
		SetupURL: defaultSetupURL, CertificateURL: defaultCertificateURL, Version: 200,
	}, factory)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := s.Close(context.Background()); err != nil {
			t.Errorf("close service: %v", err)
		}
	})
	return s
}

func signRequest(guid, encodedBody string) *http.Request {
	body, _ := json.Marshal(map[string]string{"guid": guid, "bodyBase64": encodedBody})
	request := httptest.NewRequest(http.MethodPost, "/sign", bytes.NewReader(body))
	request.Header.Set("Authorization", "Bearer "+testToken)
	request.Header.Set("Content-Type", "application/json")
	return request
}

func serve(s *signingService, request *http.Request) *httptest.ResponseRecorder {
	response := httptest.NewRecorder()
	s.ServeHTTP(response, request)
	return response
}

func TestSignPreservesRawBytesAndReusesCanonicalGUID(t *testing.T) {
	var configs []sap.Config
	var signedBodies [][]byte
	s := testService(t, func(ctx context.Context, config sap.Config) (sap.ActionSigner, error) {
		if deadline, ok := ctx.Deadline(); !ok || time.Until(deadline) > initializationTimeout {
			t.Fatal("signer initialization has no bounded deadline")
		}
		configs = append(configs, config)
		return &stubSigner{sign: func(body []byte) ([]byte, error) {
			signedBodies = append(signedBodies, append([]byte(nil), body...))
			return append([]byte{0x99}, body...), nil
		}}, nil
	})
	bodies := [][]byte{{0x00, 0xff, 0x80, 'A', '\n', 0x00}, []byte("<plist>second request</plist>")}
	for i, guid := range []string{"0200000000ab", "0200000000AB"} {
		response := serve(s, signRequest(guid, base64.StdEncoding.EncodeToString(bodies[i])))
		if response.Code != http.StatusOK {
			t.Fatalf("request %d: HTTP %d: %s", i, response.Code, response.Body.String())
		}
		var output struct {
			Signature   string `json:"signature"`
			BytesSigned int    `json:"bytesSigned"`
			GUID        string `json:"guid"`
		}
		if err := json.Unmarshal(response.Body.Bytes(), &output); err != nil {
			t.Fatal(err)
		}
		if output.Signature != base64.StdEncoding.EncodeToString(append([]byte{0x99}, bodies[i]...)) || output.BytesSigned != len(bodies[i]) || output.GUID != "0200000000AB" {
			t.Fatalf("unexpected response: %+v", output)
		}
		if response.Header().Get("Cache-Control") != "no-store" {
			t.Fatal("signature response is cacheable")
		}
		if !bytes.Equal(signedBodies[i], bodies[i]) {
			t.Fatalf("request %d bytes changed: %x", i, signedBodies[i])
		}
	}
	if len(configs) != 1 || !bytes.Equal(configs[0].HardwareID, []byte{0x02, 0, 0, 0, 0, 0xab}) {
		t.Fatalf("GUID was not decoded or signer was not reused: %+v", configs)
	}
	if configs[0].Version != 200 || configs[0].SetupURL != defaultSetupURL || configs[0].CertificateURL != defaultCertificateURL {
		t.Fatalf("unexpected SAP configuration: %+v", configs[0])
	}
}

func TestSignRejectsInvalidInputBeforeCreatingSigner(t *testing.T) {
	validJSON := `{"guid":"02","bodyBase64":"YQ=="}`
	requestBody := func(guid, body string) string {
		encoded, _ := json.Marshal(map[string]string{"guid": guid, "bodyBase64": body})
		return string(encoded)
	}
	cases := []struct {
		name        string
		body        string
		auth        string
		contentType string
		status      int
	}{
		{"missing token", validJSON, "", "application/json", http.StatusUnauthorized},
		{"wrong token", validJSON, "Bearer wrong", "application/json", http.StatusUnauthorized},
		{"wrong auth scheme", validJSON, "Basic " + testToken, "application/json", http.StatusUnauthorized},
		{"missing content type", validJSON, "Bearer " + testToken, "", http.StatusUnsupportedMediaType},
		{"wrong content type", validJSON, "Bearer " + testToken, "text/plain", http.StatusUnsupportedMediaType},
		{"malformed JSON", `{"guid":`, "Bearer " + testToken, "application/json", http.StatusBadRequest},
		{"unknown field", `{"guid":"02","bodyBase64":"YQ==","setupURL":"https://example.org"}`, "Bearer " + testToken, "application/json", http.StatusBadRequest},
		{"trailing object", validJSON + `{}`, "Bearer " + testToken, "application/json", http.StatusBadRequest},
		{"trailing junk", validJSON + `x`, "Bearer " + testToken, "application/json", http.StatusBadRequest},
		{"array", `[]`, "Bearer " + testToken, "application/json", http.StatusBadRequest},
		{"null", `null`, "Bearer " + testToken, "application/json", http.StatusBadRequest},
		{"empty GUID", requestBody("", "YQ=="), "Bearer " + testToken, "application/json", http.StatusBadRequest},
		{"odd GUID", requestBody("123", "YQ=="), "Bearer " + testToken, "application/json", http.StatusBadRequest},
		{"nonhex GUID", requestBody("ZZ", "YQ=="), "Bearer " + testToken, "application/json", http.StatusBadRequest},
		{"oversized GUID", requestBody(strings.Repeat("ab", 21), "YQ=="), "Bearer " + testToken, "application/json", http.StatusBadRequest},
		{"empty body", requestBody("02", ""), "Bearer " + testToken, "application/json", http.StatusBadRequest},
		{"invalid Base64", requestBody("02", "!!!"), "Bearer " + testToken, "application/json", http.StatusBadRequest},
		{"URL Base64", requestBody("02", "_w=="), "Bearer " + testToken, "application/json", http.StatusBadRequest},
		{"missing padding", requestBody("02", "YQ"), "Bearer " + testToken, "application/json", http.StatusBadRequest},
		{"noncanonical padding", requestBody("02", "YR=="), "Bearer " + testToken, "application/json", http.StatusBadRequest},
		{"Base64 newline", requestBody("02", "YQ==\n"), "Bearer " + testToken, "application/json", http.StatusBadRequest},
		{"oversized decoded body", requestBody("02", base64.StdEncoding.EncodeToString(make([]byte, maxSigningBytes+1))), "Bearer " + testToken, "application/json", http.StatusRequestEntityTooLarge},
		{"oversized encoded body", requestBody("02", strings.Repeat("A", maxEncodedBytes+1)), "Bearer " + testToken, "application/json", http.StatusRequestEntityTooLarge},
		{"oversized envelope", strings.Repeat(" ", maxRequestBytes+1), "Bearer " + testToken, "application/json", http.StatusRequestEntityTooLarge},
		{"oversized trailing whitespace", validJSON + strings.Repeat(" ", maxRequestBytes), "Bearer " + testToken, "application/json", http.StatusRequestEntityTooLarge},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			calls := 0
			s := testService(t, func(context.Context, sap.Config) (sap.ActionSigner, error) {
				calls++
				return &stubSigner{}, nil
			})
			request := httptest.NewRequest(http.MethodPost, "/sign", strings.NewReader(tc.body))
			request.Header.Set("Authorization", tc.auth)
			request.Header.Set("Content-Type", tc.contentType)
			response := serve(s, request)
			if response.Code != tc.status || calls != 0 {
				t.Fatalf("HTTP %d, factory calls %d; want HTTP %d and zero calls: %s", response.Code, calls, tc.status, response.Body.String())
			}
			var output map[string]string
			if err := json.Unmarshal(response.Body.Bytes(), &output); err != nil || output["error"] == "" {
				t.Fatalf("response is not a JSON error: %s", response.Body.String())
			}
		})
	}
}

func TestSignAcceptsMaximumBodyAndHardwareLength(t *testing.T) {
	s := testService(t, func(_ context.Context, config sap.Config) (sap.ActionSigner, error) {
		if len(config.HardwareID) != 20 {
			t.Fatalf("hardware bytes: %d", len(config.HardwareID))
		}
		return &stubSigner{sign: func(body []byte) ([]byte, error) {
			if len(body) != maxSigningBytes {
				t.Fatalf("body bytes: %d", len(body))
			}
			return []byte("signature"), nil
		}}, nil
	})
	response := serve(s, signRequest(strings.Repeat("ab", 20), base64.StdEncoding.EncodeToString(make([]byte, maxSigningBytes))))
	if response.Code != http.StatusOK {
		t.Fatalf("HTTP %d: %s", response.Code, response.Body.String())
	}
}

func TestSignerSwitchAndIdleExpiryClosePreviousInstance(t *testing.T) {
	var hardwareIDs [][]byte
	var closes []int
	s := testService(t, func(_ context.Context, config sap.Config) (sap.ActionSigner, error) {
		index := len(hardwareIDs)
		if index > 0 && closes[index-1] != 1 {
			t.Fatal("previous signer was not closed before creating its replacement")
		}
		hardwareIDs = append(hardwareIDs, config.HardwareID)
		closes = append(closes, 0)
		return &stubSigner{close: func() error { closes[index]++; return nil }}, nil
	})
	now := time.Now()
	s.now = func() time.Time { return now }
	for _, guid := range []string{"00", "abcd", "00"} {
		if response := serve(s, signRequest(guid, "YQ==")); response.Code != http.StatusOK {
			t.Fatal(response.Body.String())
		}
	}
	if len(hardwareIDs) != 3 || !bytes.Equal(hardwareIDs[1], []byte{0xab, 0xcd}) || !bytes.Equal(hardwareIDs[2], []byte{0}) {
		t.Fatalf("unexpected signer hardware: %x", hardwareIDs)
	}
	now = now.Add(signerTTL - time.Nanosecond)
	if response := serve(s, signRequest("00", "YQ==")); response.Code != http.StatusOK || len(hardwareIDs) != 3 {
		t.Fatalf("signer expired too early: HTTP %d, %d instances", response.Code, len(hardwareIDs))
	}
	now = now.Add(signerTTL)
	if response := serve(s, signRequest("00", "YQ==")); response.Code != http.StatusOK || len(hardwareIDs) != 4 {
		t.Fatalf("idle signer did not expire: HTTP %d, %d instances", response.Code, len(hardwareIDs))
	}
}

func TestSigningFailureInvalidatesCachedSigner(t *testing.T) {
	for _, failure := range []error{errors.New("private upstream response"), nil} {
		name := "empty signature"
		if failure != nil {
			name = "signing error"
		}
		t.Run(name, func(t *testing.T) {
			factories, signs, closes := 0, 0, 0
			s := testService(t, func(context.Context, sap.Config) (sap.ActionSigner, error) {
				factories++
				if factories > 1 {
					return &stubSigner{}, nil
				}
				return &stubSigner{
					sign: func([]byte) ([]byte, error) {
						signs++
						if signs == 1 {
							return []byte("first signature"), nil
						}
						return nil, failure
					},
					close: func() error { closes++; return nil },
				}, nil
			})
			for i, status := range []int{http.StatusOK, http.StatusBadGateway, http.StatusOK} {
				response := serve(s, signRequest("02", "YQ=="))
				if response.Code != status || strings.Contains(response.Body.String(), "private upstream response") {
					t.Fatalf("request %d: HTTP %d: %s", i, response.Code, response.Body.String())
				}
				if i == 1 && closes != 1 {
					t.Fatal("failed signer was not closed")
				}
			}
			if factories != 2 || signs != 2 || closes != 1 {
				t.Fatalf("factories/signs/closes = %d/%d/%d", factories, signs, closes)
			}
		})
	}
}

func TestInitializationFailureAndCancellationAreRetryable(t *testing.T) {
	for _, cancelInitialization := range []bool{false, true} {
		name := "upstream failure"
		if cancelInitialization {
			name = "canceled initialization"
		}
		t.Run(name, func(t *testing.T) {
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			factories, signs, closes := 0, 0, 0
			s := testService(t, func(context.Context, sap.Config) (sap.ActionSigner, error) {
				factories++
				candidate := &stubSigner{
					sign:  func([]byte) ([]byte, error) { signs++; return []byte("signature"), nil },
					close: func() error { closes++; return nil },
				}
				if factories == 1 {
					if cancelInitialization {
						cancel()
						return candidate, nil
					}
					return candidate, errors.New("private initialization detail")
				}
				return candidate, nil
			})
			response := serve(s, signRequest("02", "YQ==").WithContext(ctx))
			status := http.StatusBadGateway
			if cancelInitialization {
				status = http.StatusRequestTimeout
			}
			if response.Code != status || signs != 0 || closes != 1 || strings.Contains(response.Body.String(), "private initialization detail") {
				t.Fatalf("failed initialization leaked a signer or error detail: HTTP %d, signs/closes %d/%d, %s", response.Code, signs, closes, response.Body.String())
			}
			if response := serve(s, signRequest("02", "YQ==")); response.Code != http.StatusOK || factories != 2 {
				t.Fatalf("initialization was not retried: HTTP %d, factories %d", response.Code, factories)
			}
		})
	}
}

func TestCanceledRequestHoldsGateUntilNativeSignReturns(t *testing.T) {
	entered, finish := make(chan struct{}, 1), make(chan struct{})
	var release sync.Once
	var signs, closes atomic.Int32
	s := testService(t, func(context.Context, sap.Config) (sap.ActionSigner, error) {
		return &stubSigner{
			sign: func([]byte) ([]byte, error) {
				signs.Add(1)
				select {
				case entered <- struct{}{}:
				default:
				}
				<-finish
				return []byte("signature"), nil
			},
			close: func() error { closes.Add(1); return nil },
		}, nil
	})
	t.Cleanup(func() { release.Do(func() { close(finish) }) })
	firstCtx, cancelFirst := context.WithCancel(context.Background())
	defer cancelFirst()
	firstDone := make(chan *httptest.ResponseRecorder, 1)
	go func() { firstDone <- serve(s, signRequest("02", "YQ==").WithContext(firstCtx)) }()
	select {
	case <-entered:
	case <-time.After(2 * time.Second):
		t.Fatal("first signing call did not start")
	}
	cancelFirst()
	queuedCtx, cancelQueued := context.WithTimeout(context.Background(), 40*time.Millisecond)
	defer cancelQueued()
	queuedDone := make(chan *httptest.ResponseRecorder, 1)
	go func() { queuedDone <- serve(s, signRequest("03", "Yg==").WithContext(queuedCtx)) }()
	select {
	case response := <-queuedDone:
		if response.Code != http.StatusGatewayTimeout {
			t.Fatalf("queued request: HTTP %d: %s", response.Code, response.Body.String())
		}
	case <-time.After(2 * time.Second):
		t.Fatal("queued request ignored cancellation")
	}
	closeCtx, cancelClose := context.WithTimeout(context.Background(), 40*time.Millisecond)
	defer cancelClose()
	if err := s.Close(closeCtx); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("close while signing: %v", err)
	}
	if signs.Load() != 1 || closes.Load() != 0 {
		t.Fatal("native runtime was signed or closed concurrently")
	}
	release.Do(func() { close(finish) })
	select {
	case response := <-firstDone:
		if response.Code != http.StatusRequestTimeout {
			t.Fatalf("canceled signing request: HTTP %d", response.Code)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("signing call did not finish")
	}
	if response := serve(s, signRequest("02", "YQ==")); response.Code != http.StatusOK {
		t.Fatalf("service did not recover after cancellation: %s", response.Body.String())
	}
}

func TestHandlerBoundsQueueWithoutClientDeadline(t *testing.T) {
	entered, finish := make(chan time.Duration, 1), make(chan struct{})
	var release sync.Once
	var factories atomic.Int32
	s := testService(t, func(ctx context.Context, _ sap.Config) (sap.ActionSigner, error) {
		factories.Add(1)
		deadline, _ := ctx.Deadline()
		return &stubSigner{sign: func([]byte) ([]byte, error) {
			entered <- time.Until(deadline)
			<-finish
			return []byte("signature"), nil
		}}, nil
	})
	s.requestTimeout = 40 * time.Millisecond
	t.Cleanup(func() { release.Do(func() { close(finish) }) })
	firstDone := make(chan *httptest.ResponseRecorder, 1)
	go func() { firstDone <- serve(s, signRequest("02", "YQ==")) }()
	select {
	case remaining := <-entered:
		if remaining > s.requestTimeout {
			t.Fatalf("factory did not inherit the handler deadline: %s", remaining)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("first signing call did not start")
	}
	queuedDone := make(chan *httptest.ResponseRecorder, 1)
	go func() { queuedDone <- serve(s, signRequest("03", "YQ==")) }()
	select {
	case response := <-queuedDone:
		if response.Code != http.StatusGatewayTimeout || factories.Load() != 1 {
			t.Fatalf("server deadline did not bound the queue: HTTP %d, factories %d", response.Code, factories.Load())
		}
	case <-time.After(2 * time.Second):
		t.Fatal("request without a client deadline remained queued")
	}
	release.Do(func() { close(finish) })
	select {
	case response := <-firstDone:
		if response.Code != http.StatusGatewayTimeout {
			t.Fatalf("running request did not report its expired deadline: HTTP %d", response.Code)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("signing call did not finish")
	}
}

func TestGateIsHeldUntilPreviousSignerFinishesClosing(t *testing.T) {
	closing, finish := make(chan struct{}), make(chan struct{})
	var release sync.Once
	var factories atomic.Int32
	s := testService(t, func(context.Context, sap.Config) (sap.ActionSigner, error) {
		if factories.Add(1) == 1 {
			return &stubSigner{close: func() error {
				close(closing)
				<-finish
				return nil
			}}, nil
		}
		return &stubSigner{}, nil
	})
	t.Cleanup(func() { release.Do(func() { close(finish) }) })
	if response := serve(s, signRequest("02", "YQ==")); response.Code != http.StatusOK {
		t.Fatal(response.Body.String())
	}
	switchDone := make(chan *httptest.ResponseRecorder, 1)
	go func() { switchDone <- serve(s, signRequest("03", "YQ==")) }()
	select {
	case <-closing:
	case <-time.After(2 * time.Second):
		t.Fatal("GUID switch did not close the previous signer")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 40*time.Millisecond)
	defer cancel()
	response := serve(s, signRequest("04", "YQ==").WithContext(ctx))
	if response.Code != http.StatusGatewayTimeout || factories.Load() != 1 {
		t.Fatalf("new signer overlapped the previous native Close: HTTP %d, factories %d", response.Code, factories.Load())
	}
	release.Do(func() { close(finish) })
	select {
	case response := <-switchDone:
		if response.Code != http.StatusOK || factories.Load() != 2 {
			t.Fatalf("GUID switch did not finish: HTTP %d", response.Code)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("GUID switch remained blocked after Close returned")
	}
}

func TestHealthIsLazyAndClosedServiceRejectsSigning(t *testing.T) {
	factories := 0
	s := testService(t, func(context.Context, sap.Config) (sap.ActionSigner, error) {
		factories++
		return &stubSigner{}, nil
	})
	response := serve(s, httptest.NewRequest(http.MethodGet, "/healthz", nil))
	if response.Code != http.StatusOK || factories != 0 || response.Body.String() != "{\"status\":\"ok\"}\n" {
		t.Fatalf("health probe initialized the signer or failed: %s", response.Body.String())
	}
	if err := s.Close(context.Background()); err != nil {
		t.Fatal(err)
	}
	response = serve(s, signRequest("02", "YQ=="))
	if response.Code != http.StatusServiceUnavailable || factories != 0 {
		t.Fatalf("closed service accepted signing: HTTP %d", response.Code)
	}
}

func TestStartupRequiresTokenAndTrustedHTTPSURLs(t *testing.T) {
	cases := []struct{ token, setup, certificate string }{
		{"", defaultSetupURL, defaultCertificateURL},
		{"short", defaultSetupURL, defaultCertificateURL},
		{testToken + "\n", defaultSetupURL, defaultCertificateURL},
		{testToken, "http://example.org/setup", defaultCertificateURL},
		{testToken, defaultSetupURL, "https://user:password@example.org/cert"},
	}
	for _, tc := range cases {
		if _, err := newSigningService(tc.token, sap.Config{SetupURL: tc.setup, CertificateURL: tc.certificate, Version: 200}, nil); err == nil {
			t.Fatal("invalid startup configuration was accepted")
		}
	}
}
