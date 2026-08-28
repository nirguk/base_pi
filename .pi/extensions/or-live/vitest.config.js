import { resolve } from "node:path";

export default {
  resolve: {
    alias: {
      // Pi supplies this module as a virtual dependency at runtime. The local
      // workspace installation is used only when running the extension tests.
      typebox: resolve(process.cwd(), "../../npm/node_modules/typebox"),
    },
  },
  test: {
    include: ["test/**/*.test.ts"],
    exclude: ["node_modules/**"],
  },
};
