FROM golang:1.23-alpine AS builder
WORKDIR /app
COPY go.mod go.sum* ./
RUN go mod download
COPY . .
ARG AGENT_VERSION=dev
RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-s -w -X main.version=${AGENT_VERSION}" -o filin-agent ./cmd/agent

FROM scratch
COPY --from=builder /app/filin-agent /filin-agent
ENTRYPOINT ["/filin-agent"]
