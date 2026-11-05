// The unit tests drive the channel as a signed-in user would; the sign-in gate itself is
// covered in auth.test.js, which turns it on through the plugin config.
process.env.ATENEA_AUTH_REQUIRED = '0'
