# Sparklab deploy image — nginx serving the pre-built SPA with the exact COOP/COEP/CSP headers.
#
# Build dist/ FIRST on a machine that has the toolchain inputs (ci/toolchain-builder/out), because
# the 62MB client compiler is a heavy local artifact, not in the repo:
#     bash scripts/build-deploy.sh
# then build + run the image:
#     docker build -f deploy/Dockerfile -t sparklab .
#     docker run --rm -p 8080:80 sparklab        # → http://localhost:8080
#
# (For a fully in-container build, add a `node:22` stage that COPYs ci/toolchain-builder/out and runs
#  build-deploy.sh, then COPY --from that stage's packages/app/dist below.)
FROM nginx:alpine

COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
COPY deploy/security-headers.conf /etc/nginx/security-headers.conf
COPY packages/app/dist /usr/share/nginx/html

EXPOSE 80
