# Stage 1: Frontend Builder
FROM oven/bun:1.3.14 AS frontend-builder
WORKDIR /app/frontend
COPY frontend/package.json frontend/bun.lock ./
RUN bun install --frozen-lockfile
COPY frontend/ ./
RUN bun run build

# Stage 2: Backend Builder
FROM golang:1.26.3 AS backend-builder
WORKDIR /app/backend
COPY backend/go.mod backend/go.sum ./
RUN go mod download
COPY backend/ ./
RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-s -w" -v -o krss-server ./cmd/server/main.go

# Stage 3: Final Image
FROM alpine:latest
WORKDIR /app
RUN apk add --no-cache ca-certificates tzdata su-exec \
    && addgroup -g 1000 -S krss \
    && adduser -u 1000 -G krss -S -h /app krss

COPY --from=backend-builder /app/backend/krss-server .
COPY --from=frontend-builder /app/frontend/dist ./static
COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh \
    && mkdir -p /app/data && chown -R krss:krss /app

ENV KRSS_ADDR=:8080
ENV KRSS_DATA_DIR=/app/data
ENV KRSS_STATIC_DIR=/app/static
ENV KRSS_LOG_LEVEL=info
ENV TZ=Asia/Shanghai

EXPOSE 8080
ENTRYPOINT ["entrypoint.sh"]
CMD ["./krss-server"]
