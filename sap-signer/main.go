package main

import (
	"context"
	"errors"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/majd/ipatool/v2/internal/sap"
)

func main() {
	if err := run(); err != nil {
		log.Print(err)
		os.Exit(1)
	}
}

func run() error {
	if len(os.Args) == 2 && os.Args[1] == "healthcheck" {
		client := &http.Client{Timeout: 2 * time.Second}
		response, err := client.Get("http://127.0.0.1:8080/healthz")
		if err != nil {
			return fmt.Errorf("healthcheck failed: %w", err)
		}
		defer response.Body.Close()
		if response.StatusCode != http.StatusOK {
			return fmt.Errorf("healthcheck returned HTTP %d", response.StatusCode)
		}
		return nil
	}
	if len(os.Args) != 1 {
		return errors.New("usage: sap-signer [healthcheck]")
	}

	service, err := newSigningService(os.Getenv("SAP_API_TOKEN"), sap.Config{
		SetupURL:       envOrDefault("SAP_SETUP_URL", defaultSetupURL),
		CertificateURL: envOrDefault("SAP_CERTIFICATE_URL", defaultCertificateURL),
		Version:        200,
	}, nil)
	if err != nil {
		return err
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	server := &http.Server{
		Addr:              envOrDefault("SAP_LISTEN_ADDR", ":8080"),
		Handler:           service,
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       15 * time.Second,
		WriteTimeout:      8 * time.Minute,
		IdleTimeout:       time.Minute,
		MaxHeaderBytes:    16 << 10,
		BaseContext: func(net.Listener) context.Context {
			return ctx
		},
	}
	errorsCh := make(chan error, 1)
	go func() {
		errorsCh <- server.ListenAndServe()
	}()
	log.Printf("SAP signing service listening on %s", server.Addr)
	select {
	case err := <-errorsCh:
		_ = service.Close(context.Background())
		if errors.Is(err, http.ErrServerClosed) {
			return nil
		}
		return err
	case <-ctx.Done():
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 4*time.Minute)
		defer cancel()
		shutdownErr := server.Shutdown(shutdownCtx)
		if shutdownErr != nil {
			_ = server.Close()
		}
		// Native calls have their own execution bounds; never close their runtime concurrently.
		closeErr := service.Close(context.Background())
		return errors.Join(shutdownErr, closeErr)
	}
}

func envOrDefault(name, fallback string) string {
	if value := os.Getenv(name); value != "" {
		return value
	}
	return fallback
}
