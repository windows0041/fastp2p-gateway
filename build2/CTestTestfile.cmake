# CMake generated Testfile for 
# Source directory: /home/maoyu/gwsplit/fastp2p-gateway
# Build directory: /home/maoyu/gwsplit/fastp2p-gateway/build2
# 
# This file includes the relevant testing commands required for 
# testing this directory and lists subdirectories to be tested as well.
add_test(gateway-store "/home/maoyu/gwsplit/fastp2p-gateway/build2/test-gateway-store")
set_tests_properties(gateway-store PROPERTIES  _BACKTRACE_TRIPLES "/home/maoyu/gwsplit/fastp2p-gateway/CMakeLists.txt;53;add_test;/home/maoyu/gwsplit/fastp2p-gateway/CMakeLists.txt;0;")
add_test(gateway-config "/home/maoyu/gwsplit/fastp2p-gateway/build2/test-gateway-config")
set_tests_properties(gateway-config PROPERTIES  _BACKTRACE_TRIPLES "/home/maoyu/gwsplit/fastp2p-gateway/CMakeLists.txt;57;add_test;/home/maoyu/gwsplit/fastp2p-gateway/CMakeLists.txt;0;")
add_test(gateway-protocol "/home/maoyu/gwsplit/fastp2p-gateway/build2/test-gateway-protocol")
set_tests_properties(gateway-protocol PROPERTIES  _BACKTRACE_TRIPLES "/home/maoyu/gwsplit/fastp2p-gateway/CMakeLists.txt;61;add_test;/home/maoyu/gwsplit/fastp2p-gateway/CMakeLists.txt;0;")
add_test(release-downloads "/usr/bin/python3" "/home/maoyu/gwsplit/fastp2p-gateway/tests/test_release_downloads.py")
set_tests_properties(release-downloads PROPERTIES  _BACKTRACE_TRIPLES "/home/maoyu/gwsplit/fastp2p-gateway/CMakeLists.txt;62;add_test;/home/maoyu/gwsplit/fastp2p-gateway/CMakeLists.txt;0;")
add_test(package-cleanup "/usr/bin/python3" "/home/maoyu/gwsplit/fastp2p-gateway/tests/test_package_cleanup.py")
set_tests_properties(package-cleanup PROPERTIES  _BACKTRACE_TRIPLES "/home/maoyu/gwsplit/fastp2p-gateway/CMakeLists.txt;63;add_test;/home/maoyu/gwsplit/fastp2p-gateway/CMakeLists.txt;0;")
