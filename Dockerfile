# 零外部依赖：运行时仅使用 Node.js 内置模块（node:http / node:sqlite）
FROM node:24-slim

ENV NODE_ENV=production
WORKDIR /app

COPY package.json ./
COPY server.js ./
COPY src ./src
COPY public ./public

# 数据目录（SQLite 文件），可挂载卷持久化
RUN mkdir -p /app/data && chown -R node:node /app
USER node

ENV PORT=3000
ENV DB_PATH=/app/data/app.db
# SEED_DEMO=0 可关闭空库时的演示数据初始化
ENV SEED_DEMO=1

EXPOSE 3000
VOLUME ["/app/data"]

CMD ["node", "server.js"]
