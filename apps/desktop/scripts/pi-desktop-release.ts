// Public release metadata for reproducible desktop builds (the runtime catalog stays live).
// Source: https://api.github.com/repos/earendil-works/pi/releases/tags/v1.5.0
import { httpFetchers } from "@agentherd/host";

const tag = "v1.5.0";
const files = [
  [
    "pi-darwin-arm64.tar.gz",
    48027930,
    "a9bf0d82d58d2a7d337f4ae4171b5fc9ebffe42509527a831364c4b65adf2cdf",
  ],
  [
    "pi-darwin-x64.tar.gz",
    50541720,
    "f41b26cd9a1754abe259e05a421fb33b00936779cb0783c893a6389d1bd2ee0d",
  ],
  [
    "pi-windows-arm64.zip",
    56568696,
    "9843e4241b6935a85d49b704562cdcb6fdc78a8ec643410f32b3876a87414283",
  ],
  [
    "pi-windows-x64.zip",
    61890147,
    "12d58a70e80b16ba9f764950b7a42bdeb07959495c0db68396cf2988c0b71af3",
  ],
] as const;

export const desktopFetchers: typeof httpFetchers = {
  ...httpFetchers,
  json: async (url) => {
    if (
      (process.platform === "darwin" || process.platform === "win32") &&
      url === `https://api.github.com/repos/earendil-works/pi/releases/tags/${tag}`
    ) {
      return {
        tag_name: tag,
        assets: files.map(([name, size, hash]) => ({
          name,
          size,
          digest: `sha256:${hash}`,
          browser_download_url: `https://github.com/earendil-works/pi/releases/download/${tag}/${name}`,
        })),
      };
    }
    return httpFetchers.json(url);
  },
};
