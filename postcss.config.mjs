import { fileURLToPath } from "node:url";

const config = {
  plugins: {
    "@tailwindcss/postcss": {
      base: fileURLToPath(new URL("./app/", import.meta.url)),
    },
  },
};

export default config;
