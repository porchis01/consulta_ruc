# Imagen oficial de Playwright: ya trae Chromium + todas las librerías
# del sistema necesarias, así se evita el error de "sudo/apt-get" que
# aparece al usar --with-deps en un entorno sin permisos de root (Render).
FROM mcr.microsoft.com/playwright:v1.45.0-jammy

WORKDIR /app

# Copiar primero package.json para aprovechar el cache de Docker
COPY package*.json ./
RUN npm install --omit=dev

# Copiar el resto del proyecto (server.js, fondo.png, etc.)
COPY . .

# Render inyecta la variable PORT en tiempo de ejecución
EXPOSE 3000

CMD ["node", "server.js"]
