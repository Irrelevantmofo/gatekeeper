/** @type {import('next').NextConfig} */
const nextConfig = {
  // unpdf bundles a serverless PDF.js build; load it at runtime rather than
  // bundling it into the function (used by the credit-analyzer wrong-doc precheck).
  serverExternalPackages: ["unpdf"],
  typescript: {
    ignoreBuildErrors: true,
  },
  images: {
    unoptimized: true,
  },
}

export default nextConfig
