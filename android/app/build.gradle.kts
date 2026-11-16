plugins {
    id("com.android.application")
}

// nodejs-mobile (Node 18) is downloaded separately and unpacked to app/libnode:
//   app/libnode/bin/<abi>/libnode.so   and   app/libnode/include/node/*.h
// Without it the app still builds, but the server can't start (the app says so).
val libnodeDir = file("libnode")
val hasLibnode = file("libnode/bin/arm64-v8a/libnode.so").exists()

android {
    namespace = "app.souldew"
    compileSdk = 36
    ndkVersion = "27.2.12479018"

    defaultConfig {
        applicationId = "app.souldew"
        minSdk = 24
        targetSdk = 35
        versionCode = 1
        versionName = "0.1.0"
        ndk { abiFilters += listOf("arm64-v8a", "x86_64") }
        if (hasLibnode) {
            externalNativeBuild {
                cmake { arguments += listOf("-DLIBNODE_DIR=${libnodeDir.absolutePath}", "-DANDROID_STL=c++_shared") }
            }
        }
    }

    if (hasLibnode) {
        externalNativeBuild {
            cmake {
                path = file("src/main/cpp/CMakeLists.txt")
                version = "3.22.1"
            }
        }
        sourceSets["main"].jniLibs.srcDir("libnode/bin")
    }

    // The 3DS player: ctr/arm64-v8a/libctrhost.so (native/ctr-host built as an executable) and libazahar_libretro.so
    // (Azahar with native/azahar-patch). Files named lib*.so are the only ones an app may run (see docs/ANDROID.md).
    sourceSets["main"].jniLibs.srcDir("ctr")

    buildTypes {
        release { isMinifyEnabled = false }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    packaging { jniLibs { useLegacyPackaging = true } }
}
