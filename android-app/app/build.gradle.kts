plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.zalhariz.sentryaccess"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.zalhariz.sentryaccess"
        minSdk = 26
        targetSdk = 34
        versionCode = 1
        versionName = "1.0"
    }

    buildTypes {
        release {
            isMinifyEnabled = false
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
}

// The automation script's single source of truth is the repo-root Tampermonkey
// userscript, not a hand-maintained copy here. Copy it into assets on every
// build so editing sentry-access-automation.user.js is all that's ever needed.
val copyAutomationScript = tasks.register<Copy>("copyAutomationScript") {
    from(rootProject.projectDir.resolve("../sentry-access-automation.user.js"))
    into(layout.projectDirectory.dir("src/main/assets"))
    rename { "sentry-access-automation.js" }
}

tasks.named("preBuild") {
    dependsOn(copyAutomationScript)
}
