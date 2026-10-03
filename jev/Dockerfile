FROM python:3.12-slim
RUN pip install --no-cache-dir "mcp>=1.10,<2" "httpx>=0.27"
WORKDIR /app
COPY app.py .
ENV PYTHONUNBUFFERED=1
EXPOSE 8765
CMD ["python", "app.py"]
