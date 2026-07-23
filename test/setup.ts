import { installFakeOciEnvironment } from "./oci-fixture.js";

if (process.env.AGENT_LOOP_REAL_OCI_TEST !== "1") {
  installFakeOciEnvironment();
}
