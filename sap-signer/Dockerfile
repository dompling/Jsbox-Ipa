FROM golang:1.26.6-bookworm AS build

# Preserve the sibling layout used by go.mod, without copying user data or git.
WORKDIR /src/ipatool
COPY --from=ipatool go.mod go.sum ./
COPY --from=ipatool internal/sap ./internal/sap
COPY --from=ipatool pkg/http ./pkg/http

WORKDIR /src/ipatool-sapfix/sap-signer
COPY go.mod go.sum ./
RUN go mod download
COPY *.go ./
RUN go test ./... && go vet ./... && CGO_ENABLED=0 go build -trimpath -o /out/sap-signer .

FROM debian:bookworm-slim
COPY --from=build /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
RUN mkdir /cache && chown 10001:10001 /cache
COPY --from=build /out/sap-signer /usr/local/bin/sap-signer
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod 0555 /usr/local/bin/entrypoint.sh
ENV XDG_CACHE_HOME=/cache
USER 10001:10001
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
