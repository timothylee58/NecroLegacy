FROM python:3.12-slim
ARG WITH_PADDLE=0
ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    SAMPLE_DUMPS_DIR=/app/sample-dumps \
    OCR_ENGINE=tesseract
RUN apt-get update \
    && apt-get install -y --no-install-recommends tesseract-ocr libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*
# Unprivileged runtime user (uid 1000, the uid most container hosts expect); the app writes only to /tmp.
RUN useradd --uid 1000 --create-home --shell /usr/sbin/nologin necro
WORKDIR /app
COPY apps/api/requirements.txt apps/api/requirements-paddle.txt /tmp/
# PaddleOCR pulls in large wheels and a second OpenCV build; it stays an opt-in extra.
RUN if [ "$WITH_PADDLE" = "1" ]; then pip install -r /tmp/requirements-paddle.txt; \
    else pip install -r /tmp/requirements.txt; fi
COPY apps/api/app ./app
COPY sample-dumps ./sample-dumps
USER necro
EXPOSE 8000
# Cloud Run injects PORT (8080); other hosts and local runs fall back to 8000.
CMD ["sh", "-c", "uvicorn --factory app.main:create_app --host 0.0.0.0 --port ${PORT:-8000}"]
