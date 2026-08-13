/** @type {import('next').NextConfig} */
const nextConfig = {
  // unpdf bundles a serverless PDF.js build; load it at runtime rather than
  // bundling it into the function (used by the credit-analyzer wrong-doc precheck).
  // pdfkit ships standard-font AFM data files that the bundler drops — keep it
  // external so they load from node_modules at runtime (results PDF generation).
  serverExternalPackages: ["unpdf", "pdfkit"],
  typescript: {
    ignoreBuildErrors: true,
  },
  images: {
    unoptimized: true,
  },
}

export default nextConfig
