FROM python:3.12-slim

ARG WITH_PADDLE=0
ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    SAMPLE_DUMPS_DIR=/app/sample-dumps \
    OCR_ENGINE=tesseract

RUN apt-get update \
    && apt-get install -y --no-install-recommends tesseract-ocr libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY apps/api/requirements.txt /tmp/requirements.txt
# PaddleOCR pulls in large wheels; it stays an opt-in extra to keep the image under 1.2 GB.
RUN if [ "$WITH_PADDLE" = "1" ]; then pip install -r /tmp/requirements.txt; \
    else grep -viE '^(paddleocr|paddlepaddle)==' /tmp/requirements.txt > /tmp/slim.txt && pip install -r /tmp/slim.txt; fi

COPY apps/api/app ./app
COPY sample-dumps ./sample-dumps

EXPOSE 8000
CMD ["sh", "-c", "uvicorn --factory app.main:create_app --host 0.0.0.0 --port ${PORT:-8000}"]
