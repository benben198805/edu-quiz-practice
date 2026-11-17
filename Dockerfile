FROM alpine:3.20

# 国内镜像源；Node 20.15（Alpine 3.20 的 nodejs 包）满足 >=20 要求
RUN sed -i 's/dl-cdn.alpinelinux.org/mirrors.tencent.com/g' /etc/apk/repositories \
  && apk add --no-cache ca-certificates nodejs npm tzdata \
  && cp /usr/share/zoneinfo/Asia/Shanghai /etc/localtime \
  && echo "Asia/Shanghai" > /etc/timezone

WORKDIR /app

ENV NODE_ENV=production \
    TZ=Asia/Shanghai \
    PORT=80

COPY package*.json ./
RUN npm config set registry https://mirrors.cloud.tencent.com/npm/ \
  && npm ci --omit=dev

COPY . .

EXPOSE 80

# 数据库迁移不放在启动命令里：远端由开发者手动执行 `npm run db:migrate`
CMD ["node", "server.js"]
